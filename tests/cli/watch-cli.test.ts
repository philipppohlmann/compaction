import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { recordShapingOutcome } from "../../src/core/output-shaping-turn-state.js";
import type { ShapingTurnScope } from "../../src/core/output-shaping-turn-state.js";

/**
 * `watch` is a side pane, not a hook: it is handed no tool session id, so at the CLI it fails closed and
 * renders no output arrow. These cases exercise the RENDERING, so they inject the scope explicitly —
 * the same one they record the decision under.
 */
const WATCH_SCOPE: ShapingTurnScope = { tool: "claude-code", sessionId: "watch-test-session" };
import { TEST_OUTPUT_POLICY_VERSION, seedOutputCalibration } from "../helpers/output-calibration-fixture.js";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  receiptLinesFromJsonl,
  lastReceiptLines,
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
import { RUN_BOUNDARY_SCHEMA, startUserRun, endUserRun } from "../../src/core/gateway/run-boundary.js";
import { appendActivityEvent, DEFAULT_ACTIVITY_DIRECTORY } from "../../src/core/activity-store.js";
import { computeActivityEventId, type ActivityEvent } from "../../src/core/activity-event.js";

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
const execFileAsync = promisify(execFile);
const CLI = resolve("dist/cli/index.js");

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

  it("the compiled watch entrypoint rejects traversal correlation and malformed versioned run state", async () => {
    const config = join(dir, "nested", "config");
    const runs = join(config, "runs");
    await mkdir(runs, { recursive: true });

    const traversalCorrelation = "../../outside-run-store";
    const traversal = JSON.parse(receiptJson("traversal-receipt", 10, 1)) as GatewayReceipt;
    traversal.session_correlation_id = traversalCorrelation;
    traversal.request_started_at = "2026-07-30T10:00:00.000Z";
    const outsidePath = join(dir, "nested", "outside-run-store.json");
    const outsideRaw = JSON.stringify({
      schema: RUN_BOUNDARY_SCHEMA,
      runs: [{
        session_correlation_id: traversalCorrelation,
        run_seq: 1,
        started_at: "2026-07-30T09:59:00.000Z",
        turn_correlation_id: "b".repeat(32)
      }]
    });
    await writeFile(outsidePath, outsideRaw, "utf8");

    const canonicalCorrelation = "a".repeat(32);
    const malformed = JSON.parse(receiptJson("malformed-store", 20, 2)) as GatewayReceipt;
    malformed.session_correlation_id = canonicalCorrelation;
    malformed.request_started_at = "2026-07-30T10:00:00.000Z";
    await writeFile(
      join(runs, `${canonicalCorrelation}.json`),
      JSON.stringify({ schema: RUN_BOUNDARY_SCHEMA, runs: [null] }),
      "utf8"
    );

    const malformedTimeCorrelation = "c".repeat(32);
    const malformedTime = JSON.parse(receiptJson("bad-time-receipt", 30, 3)) as GatewayReceipt;
    malformedTime.session_correlation_id = malformedTimeCorrelation;
    malformedTime.request_started_at = "not-a-canonical-time";
    await writeFile(join(runs, `${malformedTimeCorrelation}.json`), JSON.stringify({
      schema: RUN_BOUNDARY_SCHEMA,
      runs: [{
        session_correlation_id: malformedTimeCorrelation,
        run_seq: 1,
        started_at: "2026-07-30T09:59:00.000Z",
        turn_correlation_id: "d".repeat(32)
      }]
    }), "utf8");

    const symlinkCorrelation = "e".repeat(32);
    const symlinked = JSON.parse(receiptJson("symlink-receipt", 40, 4)) as GatewayReceipt;
    symlinked.session_correlation_id = symlinkCorrelation;
    symlinked.request_started_at = "2026-07-30T10:00:00.000Z";
    const symlinkOutsidePath = join(dir, "nested", "symlink-outside.json");
    await writeFile(symlinkOutsidePath, JSON.stringify({
      schema: RUN_BOUNDARY_SCHEMA,
      runs: [{
        session_correlation_id: symlinkCorrelation,
        run_seq: 1,
        started_at: "2026-07-30T09:59:00.000Z",
        turn_correlation_id: "f".repeat(32)
      }]
    }), "utf8");
    await symlink(symlinkOutsidePath, join(runs, `${symlinkCorrelation}.json`));
    await writeFile(
      file,
      `${JSON.stringify(traversal)}\n${JSON.stringify(malformed)}\n${JSON.stringify(malformedTime)}\n${JSON.stringify(symlinked)}\n`,
      "utf8"
    );

    const { stdout } = await execFileAsync("node", [CLI, "watch", "--once", "--all"], {
      cwd: dir,
      env: { ...process.env, COMPACTION_CONFIG_DIR: config }
    });
    expect(stdout).toContain("id traversa");
    expect(stdout).toContain("id malforme");
    expect(stdout).toContain("id bad-time");
    expect(stdout).toContain("id symlink-");
    expect(await readFile(outsidePath, "utf8")).toBe(outsideRaw);
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

  it("withholds an exact Codex gateway micro-receipt until Stop, then emits only the settled aggregate", async () => {
    const sessionCorrelation = "a".repeat(32);
    const turnCorrelation = "b".repeat(32);
    const startedAt = "2026-07-30T09:59:00.000Z";
    const stoppedAt = "2026-07-30T10:01:00.000Z";
    expect(startUserRun(sessionCorrelation, startedAt, cleanEnv, turnCorrelation)).toBeDefined();

    const { print, lines } = collect();
    const controller = new AbortController();
    const done = runWatch(controller.signal, {}, { cwd: dir, print, pollMs: 30, env: cleanEnv });
    await delay(80);
    const micro = JSON.parse(receiptJson("codex-micro", 10, 1)) as GatewayReceipt;
    micro.session_correlation_id = sessionCorrelation;
    micro.request_started_at = "2026-07-30T10:00:00.000Z";
    await appendFile(file, `${JSON.stringify(micro)}\n`, "utf8");
    await delay(150); // More than four polling intervals: the receipt was observable before Stop.
    expect(lines.filter((line) => line.startsWith("compaction · "))).toEqual([]);

    // Snapshot uses the same exact run identity and must not expose the in-flight micro-result either.
    const beforeStopSnapshot: string[] = [];
    await runWatchOnce({ once: true }, { cwd: dir, env: cleanEnv, print: (line) => beforeStopSnapshot.push(line) });
    expect(beforeStopSnapshot.filter((line) => line.startsWith("compaction · "))).toEqual([]);

    expect(endUserRun(sessionCorrelation, stoppedAt, cleanEnv, turnCorrelation)).toBeDefined();
    const eventBase: ActivityEvent = {
      surface: "codex",
      provider: "openai",
      workflow_id: "codex-stop",
      session_id: `codex-session-${sessionCorrelation}`,
      run_id: `codex-stop-${turnCorrelation}`,
      input_before: 10,
      output_after: 1,
      token_source: {
        input: { source: "provider-reported" },
        output: { source: "provider-reported" }
      },
      claim_scope: "run-scoped",
      evidence_level: "exact correlated gateway run",
      approval_status: "not-required",
      recovery: { original_retained: false },
      sync_status: "local-only",
      activity_kind: "codex-stop",
      recorded_at: stoppedAt,
      run_started_at: startedAt,
      measurement_source: "gateway-run"
    };
    const event: ActivityEvent = { ...eventBase, activity_event_id: computeActivityEventId(eventBase) };
    expect((await appendActivityEvent(event, join(dir, DEFAULT_ACTIVITY_DIRECTORY))).appended).toBe(true);
    await delay(180);
    controller.abort();
    await done;

    const turns = lines.filter((line) => line.startsWith("compaction · "));
    expect(turns).toEqual(["compaction · input 10 · output 1"]);
    expect(turns.join("\n")).not.toContain("id codex-mi");

    const afterStopSnapshot: string[] = [];
    await runWatchOnce({ once: true }, { cwd: dir, env: cleanEnv, print: (line) => afterStopSnapshot.push(line) });
    expect(afterStopSnapshot.filter((line) => line.startsWith("compaction · "))).toEqual(turns);
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
    await seedOutputCalibration(env as NodeJS.ProcessEnv, {
      model: "m",
      control: [1000, 1000, 1000],
      treatment: [600, 600, 600]
    });
    await recordShapingOutcome(WATCH_SCOPE, "shape", env as NodeJS.ProcessEnv);
    await appendFile(file, receiptJson("aaaabbbb11112222333344445555aaaa", 9000, 500), "utf8");

    const { print, lines } = collect();
    const controller = new AbortController();
    const done = runWatch(controller.signal, { all: true }, { cwd: dir, print, pollMs: 30, env, shapingScope: WATCH_SCOPE });
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
    expect(header).toContain("settled Codex Stop turns, exact Gateway-backed Claude Stop aggregates");
    expect(header).toContain("positively reconciled hook-only task-notification continuations");
    expect(header).not.toContain("Interactive Codex turns settle after Stop; other turns");
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
  const shapedRecord = JSON.stringify({
    ...JSON.parse(record),
    model: "gpt-5",
    output_shaping_state: "attached-this-pass",
    output_shaping_policy_version: TEST_OUTPUT_POLICY_VERSION
  });

  it("HISTORICAL receipts never carry the arrow, even with a rate available", () => {
    // `shapedEvidence` omitted = historical. The current shaping decision says nothing about a receipt
    // from three days ago — the same reason the ceiling clause stays off replayed lines.
    const lines = receiptLinesFromJsonl(record, {
      productTier: "basic",
      calibrationResolver: () => ({ availability: "measured", reductionPct: 40 } as never)
    });
    expect(lines[0]).not.toContain("→");
    expect(lines[0]).toContain("output 500");
  });

  it("a LIVE batch with evidence carries the arrow", () => {
    const lines = receiptLinesFromJsonl(shapedRecord, {
      productTier: "basic",
      calibrationResolver: () => ({ availability: "measured", reductionPct: 40 } as never),
      shapedEvidence: true
    });
    expect(lines[0]).toContain("→500");
  });

  it("evidence FALSE suppresses the arrow even on a live batch (a held turn)", () => {
    const lines = receiptLinesFromJsonl(record, {
      productTier: "basic",
      calibrationResolver: () => ({ availability: "measured", reductionPct: 40 } as never),
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
      approval_status: "auto-applied-by-policy",
      authorization_id: "pref-1234567890abcdef12345678",
      estimated_input_tokens_before: 41210,
      estimated_input_tokens_after: 21876,
      applied_components: ["lcm-compaction"],
      upstream_status: 200,
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

  it("a full-tier device keeps deterministic input evidence without promoting it to private Full", () => {
    const deterministic = {
      receipt_id: "ffffffff-0000-0000-0000-000000000000",
      captured_at: "2026-08-03T00:00:00Z",
      provider: "openai",
      endpoint: "/v1/responses",
      mode: "apply",
      request_mutated: true,
      approval_status: "explicit-mode",
      estimated_input_tokens_before: 100,
      estimated_input_tokens_after: 80,
      applied_components: ["deterministic-compaction"],
      upstream_status: 200,
      model: "gpt-5",
      tokens: { prompt_input: 80, output: 12 },
      content_uploaded: false
    };

    const [line] = receiptLinesFromJsonl(JSON.stringify(deterministic), { productTier: "full" });
    expect(line).toContain("input 100→80");
    expect(line).not.toContain("observed input");
    expect(line).not.toContain("full apply");

    for (const [before, after] of [
      ["100", 80],
      [100, "80"],
      [100.8, 80.2],
      [-1, -2],
      [0, -1]
    ]) {
      const [malformed] = receiptLinesFromJsonl(
        JSON.stringify({
          ...deterministic,
          estimated_input_tokens_before: before,
          estimated_input_tokens_after: after
        }),
        { productTier: "full" }
      );
      expect(malformed).not.toMatch(/input [-\d,]+→[-\d,]+/);
      expect(malformed).not.toContain("full apply");
    }
  });

  it("persisted malformed token fields fail closed through the real JSONL replay path", () => {
    const canonical = {
      receipt_id: "eeeeeeee-0000-0000-0000-000000000000",
      captured_at: "2026-08-03T00:00:00Z",
      provider: "openai",
      endpoint: "/v1/responses",
      mode: "apply",
      request_mutated: true,
      approval_status: "auto-applied-by-policy",
      authorization_id: "pref-1234567890abcdef12345678",
      estimated_input_tokens_before: 41210,
      estimated_input_tokens_after: 21876,
      applied_components: ["lcm-compaction"],
      upstream_status: 200,
      model: "gpt-5",
      content_uploaded: false
    };

    for (const tokens of [
      null,
      { prompt_input: 22012, output: "999" },
      { prompt_input: 22012, output: -3 },
      { prompt_input: 22012, output: 1.8 }
    ]) {
      let lines: string[] = [];
      expect(() => {
        lines = receiptLinesFromJsonl(JSON.stringify({ ...canonical, tokens }), { productTier: "full" });
      }).not.toThrow();
      expect(lines.join("\n")).not.toMatch(/output (?:999|[-−]3|1(?:\.8)?)(?:\D|$)/);
    }

    const [validInputInvalidOutput] = receiptLinesFromJsonl(
      JSON.stringify({ ...canonical, tokens: { prompt_input: 22012, output: "999" } }),
      { productTier: "full" }
    );
    expect(validInputInvalidOutput).toContain("input 41,210→21,876");
    expect(validInputInvalidOutput).toContain("full apply");
    expect(validInputInvalidOutput).not.toContain("output");
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

  it("coalesces cumulative Claude Stop snapshots and suppresses only their exact gateway micro-receipts", async () => {
    const correlation = "a".repeat(32);
    const runId = `claude-stop-${"b".repeat(32)}`;
    const startedAt = "2026-07-30T09:59:00.000Z";
    const parentStoppedAt = "2026-07-30T10:00:30.000Z";
    const finalStoppedAt = "2026-07-30T10:01:00.000Z";
    const claudeEvent = (input: number, output: number, recordedAt: string): ActivityEvent => {
      const base: ActivityEvent = {
        surface: "claude_code",
        provider: "anthropic",
        model_label: "claude-x",
        workflow_id: "claude-stop",
        session_id: `claude-session-${correlation}`,
        run_id: runId,
        input_before: input,
        output_after: output,
        token_source: {
          input: { source: "provider-reported" },
          output: { source: "provider-reported" }
        },
        policy_used: TEST_OUTPUT_POLICY_VERSION,
        claim_scope: "run-scoped",
        evidence_level: "exact correlated gateway run",
        approval_status: "not-required",
        recovery: { original_retained: false },
        sync_status: "local-only",
        activity_kind: "claude-stop",
        recorded_at: recordedAt,
        run_started_at: startedAt,
        measurement_source: "gateway-run",
        output_shaping_state: "active",
        output_estimate_state: "unseeded",
        apply_posture: "basic"
      };
      return { ...base, activity_event_id: computeActivityEventId(base) };
    };
    expect((await appendActivityEvent(
      claudeEvent(100, 20, parentStoppedAt),
      join(dir, DEFAULT_ACTIVITY_DIRECTORY)
    )).appended).toBe(true);
    expect((await appendActivityEvent(
      claudeEvent(300, 30, finalStoppedAt),
      join(dir, DEFAULT_ACTIVITY_DIRECTORY)
    )).appended).toBe(true);

    const exactMicro = JSON.parse(receiptJson("claude-micro", 100, 20)) as GatewayReceipt;
    exactMicro.session_correlation_id = correlation;
    exactMicro.request_started_at = "2026-07-30T10:00:00.000Z";
    const adjacent = JSON.parse(receiptJson("adjacent-receipt", 50, 5)) as GatewayReceipt;
    adjacent.session_correlation_id = correlation;
    adjacent.request_started_at = "2026-07-30T10:02:00.000Z";
    await appendFile(file, `${JSON.stringify(exactMicro)}\n${JSON.stringify(adjacent)}\n`, "utf8");

    const { print, lines } = collect();
    await runWatchOnce({ once: true, lines: 2 }, { cwd: dir, env: cleanEnv, print });
    const turns = lines.filter((line) => line.startsWith("compaction · "));
    expect(turns).toEqual([
      "compaction · observed input 50 · output 5 · id adjacent",
      "compaction · observed input 300 · output N/A→30 (N/A%, est.) · basic shaping"
    ]);
    expect(turns.join("\n")).not.toContain("claude-");
    expect(turns.join("\n")).not.toContain("47%");

    const status = await lastReceiptLines(2, { cwd: dir, env: cleanEnv });
    expect(status.lines).toEqual(turns);

    // `--all` remains the explicit physical diagnostic view; it must not hide the micro receipt.
    const diagnostic: string[] = [];
    await runWatchOnce(
      { once: true, all: true },
      { cwd: dir, env: cleanEnv, print: (line) => diagnostic.push(line) }
    );
    expect(diagnostic.join("\n")).toContain("id claude-m");
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
    // An issuer-exhausted lease. The pause covers INPUT optimization on every upstream route, and
    // nothing else: output shaping owes the allowance nothing, so the header must say what kept
    // running rather than claim a global stop.
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
    expect(lines.join("\n")).toContain("Community input optimization is paused");
    expect(lines.join("\n")).toContain(`It resumes ${periodEndUtc(currentPeriodId())}`);
  });

  it("both headers name what stopped and what did not, without narrowing to one route", async () => {
    // `watch` renders this notice globally, with no way to know which route the next turn takes — and
    // it no longer needs to: the allowance governs Hybrid input optimization on every route, so the
    // unqualified sentence is the true one. What it must still say is that output shaping is running,
    // because that is the capability the ceiling did NOT take away.
    const header = [...(await watchHeaderLines(false, leaseEnv)), ...(await watchOnceHeaderLines(leaseEnv))].join("\n");
    expect(header).toContain("Community input optimization is paused");
    expect(header).toContain("Output shaping remains active");
    expect(header).not.toContain("Subscription-routed turns are unaffected");
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
  const PAUSE = { reason: "insufficient" as const, resets_on: "2099-01-01", scope: "all-routes" as const };

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
