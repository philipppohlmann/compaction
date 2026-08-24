import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { recordShapingOutcome } from "../../src/core/output-shaping-turn-state.js";
import { updateCalibrationFromAbSummary } from "../../src/core/output-shaping-calibration-store.js";
import {
  addOutputShapingAbRun,
  initOutputShapingAbExperiment,
  summarizeOutputShapingAb,
  type OutputShapingAbRun
} from "../../src/core/output-shaping-ab.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  receiptLinesFromJsonl,
  lastTurnAllowancePause,
  runWatch,
  runWatchOnce,
  watchHeaderLines,
  watchOnceHeaderLines,
  WATCH_ONCE_DEFAULT_LINES
} from "../../src/cli/commands/watch.js";
import { DEFAULT_GATEWAY_RECEIPTS_DIR, GATEWAY_RECEIPTS_FILE, type GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { currentPeriodId, periodEndUtc } from "../../src/core/entitlement/lease.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { proUrl } from "../../src/core/pro-destination.js";

/**
 * `compaction watch` core. Drives the REAL formatter through a temp receipts.jsonl with real appends:
 * proves that new receipts print as canonical content-free lines the moment they land, that pre-existing
 * receipts are ignored unless `--all`, and that the kill switch silences the lines.
 */

function receiptJson(id: string, input: number, output: number): string {
  const r: GatewayReceipt = {
    receipt_id: id,
    captured_at: "2026-07-30T10:00:00.000Z",
    provider: "anthropic",
    model: "m",
    endpoint: "/v1/messages",
    mode: "record",
    upstream_status: 200,
    model_visible_bytes_changed: false,
    tokens: { prompt_input: input, output },
    fresh_billed_input_reduction: { available: false, note: "x" },
    token_source: "provider-reported",
    cache_source: "unavailable",
    cost_source: "unavailable",
    reasons: { cost: "x" },
    claim_scope: "run-scoped",
    approval_status: "not-required",
    sync_status: "local-only",
    content_uploaded: false,
    label: "x"
  };
  return `${JSON.stringify(r)}\n`;
}

let dir: string;
let file: string;
/** An EMPTY config dir, so no assertion here depends on the developer's own `~/.compaction`. */
let cleanEnv: { COMPACTION_CONFIG_DIR: string };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "watch-cli-"));
  const gwDir = join(dir, DEFAULT_GATEWAY_RECEIPTS_DIR);
  await mkdir(gwDir, { recursive: true });
  file = join(gwDir, GATEWAY_RECEIPTS_FILE);
  cleanEnv = { COMPACTION_CONFIG_DIR: await mkdtemp(join(tmpdir(), "watch-cli-cfg-")) };
});
afterEach(async () => {
  for (const path of [dir, cleanEnv.COMPACTION_CONFIG_DIR]) {
    await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function collect(): { print: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { print: (line: string) => lines.push(line), lines };
}

describe("receiptLinesFromJsonl", () => {
  it("renders only lines that parse to a receipt with something honest to print", () => {
    const chunk = receiptJson("aaaaaaaa11112222333344445555aaaa", 1000, 50) + "\n{malformed}\n" + receiptJson("bbbbbbbb11112222333344445555bbbb", 2000, 60);
    const out = receiptLinesFromJsonl(chunk);
    // No tier label: these receipts record nothing that proves a posture, and `watch` replays history,
    // so there is no per-turn evidence to fall back on either. The Open `observed input` vocabulary is
    // what this surface has always shown and does not move with the label.
    expect(out).toEqual([
      "compaction · observed input 1,000 · output 50 · id aaaaaaaa",
      "compaction · observed input 2,000 · output 60 · id bbbbbbbb"
    ]);
  });
});

describe("runWatch - live follow", () => {
  it("prints NEW receipts as canonical lines the moment they land", async () => {
    const { print, lines } = collect();
    const controller = new AbortController();
    const done = runWatch(controller.signal, {}, { cwd: dir, print, pollMs: 30, env: cleanEnv });

    await delay(80);
    await appendFile(file, receiptJson("cccccccc11112222333344445555cccc", 10000, 100), "utf8");
    await delay(120);
    await appendFile(file, receiptJson("dddddddd11112222333344445555dddd", 20000, 200), "utf8");
    await delay(120);
    controller.abort();
    await done;

    const receiptLines = lines.filter((l) => l.startsWith("compaction · "));
    // Unlabelled: neither receipt records a mutation, and with no shaped turn on disk there is no
    // per-turn evidence for a posture either. The label used to read off the device's stored mode.
    expect(receiptLines).toEqual([
      "compaction · observed input 10,000 · output 100 · id cccccccc",
      "compaction · observed input 20,000 · output 200 · id dddddddd"
    ]);
  });

  it("ignores pre-existing receipts by default (only new after start)", async () => {
    await appendFile(file, receiptJson("eeeeeeee11112222333344445555eeee", 5000, 40), "utf8");
    const { print, lines } = collect();
    const controller = new AbortController();
    const done = runWatch(controller.signal, {}, { cwd: dir, print, pollMs: 30, env: cleanEnv });
    await delay(120);
    controller.abort();
    await done;
    expect(lines.filter((l) => l.startsWith("compaction · "))).toEqual([]);
  });

  /**
   * THE INTEGRATION GAP THAT LET A DEFECT THROUGH. `--all` leaves the offset at
   * 0, so the FIRST drain is the entire history — and it was resolving live shaped-evidence and
   * stamping it across every replayed line, the exact overclaim this file's contract forbids. The
   * unit tests around `receiptLinesFromJsonl` were green throughout, because none of them reach
   * `runWatch({ all: true })`. This one does.
   */
  it("--all replay carries NO arrow, even with a shaped turn recorded and a rate available", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "watch-replay-cfg-"));
    const env = { COMPACTION_CONFIG_DIR: configDir };
    // A calibrated rate AND a freshly-shaped turn: BOTH preconditions for an arrow are present, so the
    // test is non-vacuous — with the historical guard removed it FAILS (verified by disabling it).
    // Seeded through the real API; an earlier hand-written fixture used the wrong filename and shape,
    // produced no rate, and made this test pass either way.
    const run = (arm: "control" | "treatment", outputTokens: number): OutputShapingAbRun => ({
      arm,
      outputTokens,
      inputTokens: 1000,
      providerReported: true,
      tokenSource: "provider-reported",
      ...(arm === "treatment"
        ? { policyFamily: "output_shaping" as const, policyNames: ["concise_response"], evalMarkersPreserved: true }
        : {})
    });
    let exp = initOutputShapingAbExperiment({ experimentId: "watch-cal", taskShape: "code" });
    for (const r of [run("control", 1000), run("treatment", 600)]) exp = addOutputShapingAbRun(exp, r);
    await updateCalibrationFromAbSummary(summarizeOutputShapingAb(exp), env as NodeJS.ProcessEnv);
    await recordShapingOutcome("shape", env as NodeJS.ProcessEnv);
    await appendFile(file, receiptJson("aaaabbbb11112222333344445555aaaa", 9000, 500), "utf8");

    const { print, lines } = collect();
    const controller = new AbortController();
    const done = runWatch(controller.signal, { all: true }, { cwd: dir, print, pollMs: 30, env });
    await delay(150);
    controller.abort();
    await done;

    const receipts = lines.filter((l) => l.startsWith("compaction · "));
    expect(receipts.length).toBeGreaterThan(0);
    for (const line of receipts) {
      expect(line, "a replayed receipt must never carry an arrow derived from the CURRENT turn").not.toContain("→");
    }
  });

  it("--all replays the existing receipts first", async () => {
    await appendFile(file, receiptJson("ffffffff11112222333344445555ffff", 5000, 40), "utf8");
    const { print, lines } = collect();
    const controller = new AbortController();
    const done = runWatch(controller.signal, { all: true }, { cwd: dir, print, pollMs: 30, env: cleanEnv });
    await delay(120);
    controller.abort();
    await done;
    expect(lines.filter((l) => l.startsWith("compaction · "))).toEqual([
      "compaction · observed input 5,000 · output 40 · id ffffffff"
    ]);
  });

  it("kill switch (COMPACTION_RECEIPT_LINE=0) silences the lines", async () => {
    const { print, lines } = collect();
    const controller = new AbortController();
    const done = runWatch(controller.signal, {}, { cwd: dir, print, pollMs: 30, env: { COMPACTION_RECEIPT_LINE: "0" } });
    await delay(80);
    await appendFile(file, receiptJson("99999999111122223333444455559999", 10000, 100), "utf8");
    await delay(120);
    controller.abort();
    await done;
    expect(lines.filter((l) => l.startsWith("compaction · "))).toEqual([]);
  });

  it("waits for a not-yet-created receipts file, then follows it", async () => {
    // Fresh dir with NO receipts file yet.
    const fresh = await mkdtemp(join(tmpdir(), "watch-wait-"));
    try {
      const { print, lines } = collect();
      const controller = new AbortController();
      const done = runWatch(controller.signal, {}, { cwd: fresh, print, pollMs: 30, env: cleanEnv });
      await delay(80);
      const gwDir = join(fresh, DEFAULT_GATEWAY_RECEIPTS_DIR);
      await mkdir(gwDir, { recursive: true });
      await appendFile(join(gwDir, GATEWAY_RECEIPTS_FILE), receiptJson("77777777111122223333444455557777", 3000, 30), "utf8");
      await delay(150);
      controller.abort();
      await done;
      expect(lines.filter((l) => l.startsWith("compaction · "))).toEqual([
        "compaction · observed input 3,000 · output 30 · id 77777777"
      ]);
    } finally {
      await rm(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("header is content-free", async () => {
    const header = (await watchHeaderLines(false)).join("\n");
    expect(header).toContain("Content-free");
    expect(header).toContain("Ctrl-C to stop");
  });
});

describe("receiptLinesFromJsonl - tier + per-turn evidence", () => {
  const record = JSON.stringify({
    receipt_id: "cccccccc-0000-0000-0000-000000000000",
    captured_at: "2026-08-03T00:00:00Z",
    provider: "openai",
    endpoint: "/v1/chat/completions",
    mode: "record",
    request_mutated: false,
    tokens: { prompt_input: 100, output: 500 },
    content_uploaded: false
  });

  it("HISTORICAL receipts never carry the arrow, even with a rate available", () => {
    // `shapedEvidence` omitted = historical. The current shaping decision says nothing about a receipt
    // from three days ago — the same reason the ceiling clause stays off replayed lines.
    const lines = receiptLinesFromJsonl(record, {
      productTier: "basic",
      reduction: { availability: "measured", reductionPct: 40 } as never
    });
    expect(lines[0]).not.toContain("→");
    expect(lines[0]).toContain("output 500");
  });

  it("a LIVE batch with evidence carries the arrow", () => {
    const lines = receiptLinesFromJsonl(record, {
      productTier: "basic",
      reduction: { availability: "measured", reductionPct: 40 } as never,
      shapedEvidence: true
    });
    expect(lines[0]).toContain("→500");
  });

  it("evidence FALSE suppresses the arrow even on a live batch (a held turn)", () => {
    const lines = receiptLinesFromJsonl(record, {
      productTier: "basic",
      reduction: { availability: "measured", reductionPct: 40 } as never,
      shapedEvidence: false
    });
    expect(lines[0]).not.toContain("→");
  });

  it("a full-tier device keeps the community builder — a real apply is not stripped to a bare line", () => {
    const applied = JSON.stringify({
      receipt_id: "dddddddd-0000-0000-0000-000000000000",
      captured_at: "2026-08-03T00:00:00Z",
      provider: "openai",
      endpoint: "/v1/chat/completions",
      mode: "apply",
      request_mutated: true,
      estimated_input_tokens_before: 41210,
      estimated_input_tokens_after: 21876,
      model: "gpt-4o",
      tokens: { prompt_input: 22012, output: 412 },
      content_uploaded: false
    });
    const [line] = receiptLinesFromJsonl(applied, { productTier: "full" });
    expect(line, "a real Community apply must keep its label").toContain("full apply");
    expect(line).toContain("41,210→21,876");

    // A NON-apply turn on the same full-tier device falls back to the honest Open line — and that
    // fallback claims no posture at all: the receipt records none, and being on a full-tier device
    // today says nothing about the turn that produced it.
    const [fallback] = receiptLinesFromJsonl(record, { productTier: "full" });
    expect(fallback).not.toContain("full apply");
    expect(fallback).not.toContain("apply off");
    expect(fallback).toContain("observed input 100");
  });
});

describe("runWatchOnce - snapshot mode (prints last N and EXITS, no follow)", () => {
  async function seed(count: number): Promise<void> {
    let blob = "";
    for (let i = 0; i < count; i++) {
      const id = `${String(i).padStart(8, "0")}1111222233334444${String(i).padStart(4, "0")}`.slice(0, 32);
      blob += receiptJson(id, 1000 + i, 10 + i);
    }
    await appendFile(file, blob, "utf8");
  }

  it("prints the LAST 10 by default and returns (does not hang / follow)", async () => {
    await seed(15);
    const { print, lines } = collect();
    // No abort signal, no timers: if this did not exit on its own, the test would hang.
    await runWatchOnce({ once: true }, { cwd: dir, print });
    const receiptLines = lines.filter((l) => l.startsWith("compaction · "));
    expect(receiptLines).toHaveLength(WATCH_ONCE_DEFAULT_LINES);
    // The last two seeded receipts (inputs 1013, 1014) must be the tail of the snapshot.
    expect(receiptLines[receiptLines.length - 1]).toContain("input 1,014");
    expect(receiptLines[0]).toContain("input 1,005"); // 15 total, last 10 → starts at index 5
  });

  it("-n <count> shows exactly that many recent receipts", async () => {
    await seed(15);
    const { print, lines } = collect();
    await runWatchOnce({ once: true, lines: 3 }, { cwd: dir, print });
    const receiptLines = lines.filter((l) => l.startsWith("compaction · "));
    expect(receiptLines).toHaveLength(3);
    expect(receiptLines[receiptLines.length - 1]).toContain("input 1,014");
  });

  it("--once --all prints every receipt (no tail) and exits", async () => {
    await seed(4);
    const { print, lines } = collect();
    await runWatchOnce({ once: true, all: true }, { cwd: dir, print });
    expect(lines.filter((l) => l.startsWith("compaction · "))).toHaveLength(4);
  });

  it("no receipts store yet → an honest note, still exits", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "watch-once-empty-"));
    try {
      const { print, lines } = collect();
      await runWatchOnce({ once: true }, { cwd: fresh, print });
      expect(lines.filter((l) => l.startsWith("compaction · "))).toEqual([]);
      expect(lines.join("\n")).toMatch(/No turns recorded yet/i);
    } finally {
      await rm(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("honors the COMPACTION_RECEIPT_LINE=0 kill switch (no lines, still exits)", async () => {
    await seed(5);
    const { print, lines } = collect();
    await runWatchOnce({ once: true }, { cwd: dir, print, env: { COMPACTION_RECEIPT_LINE: "0" } });
    expect(lines.filter((l) => l.startsWith("compaction · "))).toEqual([]);
    expect(lines.join("\n")).toMatch(/kill switch/i);
  });
});

/**
 * THE CEILING NOTICE ON `watch`, on BOTH of its surfaces and against the INJECTED environment.
 *
 * Two defects met here. `runWatch` accepted a `deps.env` but handed the header none, so the notice
 * resolved the tier against `process.env` while every other decision in the command used the
 * injected one — which is also exactly how these tests redirect `COMPACTION_CONFIG_DIR`, so the
 * behaviour was untestable as well as wrong. And `--once` never consulted the resolver at all, so a
 * user taking a snapshot at the ceiling learned nothing that live `watch` and `status` both told them.
 */
describe("the allowance ceiling notice on watch", () => {
  let configDir = "";
  let leaseEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "watch-ceiling-"));
    // An issuer-exhausted lease. The pause covers API-key routed turns only: subscription-route full
    // apply consumes no allowance, so the header must say so rather than claim a global stop.
    leaseEnv = provisionValidLease(configDir, { allowance_tokens: 0 }, { productMode: "full" }) as NodeJS.ProcessEnv;
    leaseEnv.COMPACTION_LEASE_DEV_ROOT = undefined;
  });
  afterEach(() => {
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  });

  it("live `watch` renders it from the INJECTED env, not process.env", async () => {
    const { print, lines } = collect();
    const controller = new AbortController();
    const done = runWatch(controller.signal, {}, { cwd: dir, print, pollMs: 30, env: leaseEnv });
    controller.abort();
    await done;
    expect(lines.join("\n")).toContain(`It resumes ${periodEndUtc(currentPeriodId())}`);
  });

  it("`watch --once` renders the SAME fact (a snapshot at the ceiling must not be silent)", async () => {
    const { print, lines } = collect();
    await runWatchOnce({ once: true }, { cwd: dir, print, env: leaseEnv });
    expect(lines.join("\n")).toContain("Community input optimization on API-key routed turns is paused");
    expect(lines.join("\n")).toContain(`It resumes ${periodEndUtc(currentPeriodId())}`);
  });

  it("both headers scope the pause to API-key turns and say subscription turns are unaffected", async () => {
    // `watch` renders this notice globally, with no way to know which route the next turn takes. An
    // unqualified "Community full apply is paused" is false for a subscription user whose apply is
    // running normally — and an exhausted API allowance never stops that route.
    const header = [...(await watchHeaderLines(false, leaseEnv)), ...(await watchOnceHeaderLines(leaseEnv))].join("\n");
    expect(header).toContain("Community input optimization on API-key routed turns is paused");
    expect(header).toContain("Subscription-routed turns are unaffected");
  });

  it("both headers stay silent for a device with no ceiling", async () => {
    const clean = { COMPACTION_CONFIG_DIR: mkdtempSync(join(tmpdir(), "watch-noceiling-")) };
    try {
      expect((await watchHeaderLines(false, clean as NodeJS.ProcessEnv)).join("\n")).not.toContain("paused");
      expect((await watchOnceHeaderLines(clean as NodeJS.ProcessEnv)).join("\n")).not.toContain("paused");
    } finally {
      rmSync(clean.COMPACTION_CONFIG_DIR, { recursive: true, force: true });
    }
  });

  /**
   * INVERTED ON THE URL. This used to forbid any destination, which left the user who was
   * actually blocked with a sentence and nowhere to act on it. The header now carries THE canonical Pro
   * destination — and exactly one of it. A price and a purchase verb stay forbidden: the ceiling
   * refuses and degrades, it never charges.
   */
  it("names no figure and no price, and links ONE canonical destination", async () => {
    const header = [...(await watchHeaderLines(false, leaseEnv)), ...(await watchOnceHeaderLines(leaseEnv))].join("\n");
    expect(header).not.toMatch(/\$\d/);
    expect(header).not.toMatch(/purchase|buy|checkout|monthly|per month/i);
    const urls = (header.match(/https?:\/\/\S+/g) ?? []).map((u) => u.replace(/\u001B\[[0-9;]*m/g, ""));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toBe(proUrl(leaseEnv));
  });
});

/**
 * `lastTurnAllowancePause` — the one witness for the `insufficient` ceiling.
 *
 * Nothing else on the device can report it: the lease is valid, its grant non-zero, the journal shows
 * tokens remaining. Only the turn that was refused recorded WHY. So three properties have to hold, and
 * each of them failed a real surface before it did:
 *  - it answers from the NEWEST turn (a stale ceiling is a false claim about now);
 *  - it answers from the CALLER'S project (the header used `process.cwd()` and read the repo's own store);
 *  - it answers off a store of any size without stalling the feed (that store was 31 MB, and reading it
 *    whole pushed the first line of `watch` past a 120 ms budget — two live-follow tests caught it).
 */
describe("lastTurnAllowancePause", () => {
  const PAUSE = { reason: "insufficient" as const, resets_on: "2099-01-01", scope: "api-key-route" as const };

  /** A receipt line carrying (or not carrying) an allowance pause. */
  function pausedReceipt(id: string, pause?: typeof PAUSE): string {
    const base = JSON.parse(receiptJson(id, 1000, 50)) as GatewayReceipt;
    return `${JSON.stringify(pause ? { ...base, allowance_pause: pause } : base)}\n`;
  }

  it("reports the newest turn's pause", async () => {
    await appendFile(file, pausedReceipt("aaaaaaaa11112222333344445555aaaa") + pausedReceipt("bbbbbbbb11112222333344445555bbbb", PAUSE), "utf8");
    expect(await lastTurnAllowancePause({ cwd: dir })).toEqual(PAUSE);
  });

  it("reports NOTHING when the newest turn ran unimpeded, even though an older one was paused", async () => {
    await appendFile(file, pausedReceipt("aaaaaaaa11112222333344445555aaaa", PAUSE) + pausedReceipt("bbbbbbbb11112222333344445555bbbb"), "utf8");
    expect(await lastTurnAllowancePause({ cwd: dir })).toBeUndefined();
  });

  it("reads the CALLER'S project, not the process cwd", async () => {
    await appendFile(file, pausedReceipt("bbbbbbbb11112222333344445555bbbb", PAUSE), "utf8");
    const elsewhere = await mkdtemp(join(tmpdir(), "watch-other-project-"));
    try {
      expect(await lastTurnAllowancePause({ cwd: elsewhere })).toBeUndefined();
      // …and the header built for that project stays silent about a ceiling it cannot see.
      expect((await watchOnceHeaderLines(cleanEnv as NodeJS.ProcessEnv, elsewhere)).join("\n")).not.toContain("Upgrade to Pro");
      expect((await watchOnceHeaderLines(cleanEnv as NodeJS.ProcessEnv, dir)).join("\n")).toContain("Upgrade to Pro");
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("finds the newest turn behind a 32 MB store, without reading it", async () => {
    // 32 MB is not a stress figure — it is the size the receipts store in this repo reached from
    // ordinary dogfooding. Reading it whole to answer a question about its LAST line delayed the first
    // line of `watch` by hundreds of milliseconds, which is what the budget below pins. Written in one
    // go (appending 60k lines individually costs more than the read it is testing).
    const filler = pausedReceipt("0".repeat(32));
    await appendFile(file, filler.repeat(Math.ceil((32 * 1024 * 1024) / filler.length)), "utf8");
    await appendFile(file, pausedReceipt("ffffffff11112222333344445555ffff", PAUSE), "utf8");
    const started = process.hrtime.bigint();
    expect(await lastTurnAllowancePause({ cwd: dir })).toEqual(PAUSE);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs, "the header path must not stall on an unbounded append-only store").toBeLessThan(50);
  });
});
