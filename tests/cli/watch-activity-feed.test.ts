import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lastReceiptLines,
  runWatch,
  runWatchOnce,
  watchHeaderLines,
  watchOnceHeaderLines
} from "../../src/cli/commands/watch.js";
import { bridgeCursorShimActivity, bridgeCodexShimActivity } from "../../src/core/shim-capture-bridge.js";
import { activityLinesFromJsonl, WATCH_ACTIVITY_SURFACES } from "../../src/core/activity-receipt-line.js";

/**
 * `compaction watch` MUST WORK FOR CURSOR.
 *
 * `watch` tailed only `<cwd>/.compaction/gateway/receipts.jsonl`, and gateway receipts are written only
 * by the gateway server. Cursor's shim is `kind: "capture"`: its turns go through
 * `core/shim-capture-bridge.ts` into `<cwd>/.compaction/activity/`, and NEVER produce a gateway
 * receipt. So a Cursor user who completed setup and was pointed at `compaction watch` — the surface the
 * setup flow names as their guaranteed one — got an empty feed forever, no matter how many turns they
 * ran.
 *
 * These tests drive the REAL capture bridge (not hand-written JSON), so they prove the actual path a
 * Cursor turn takes, and they pin the tier honesty: Cursor is LOCAL-ESTIMATE only (chars/4; the vendor
 * reports no usage) and `watch` may never relabel that as provider-reported, nor print a zero for an
 * axis that was simply not reported.
 */

let dir: string;
/** An EMPTY config dir, so no assertion here depends on the developer's own `~/.compaction`. */
let cleanEnv: { COMPACTION_CONFIG_DIR: string };

/** A realistic `cursor-agent … --output-format json` capture (a separable `result` field). */
const CURSOR_OUTPUT = JSON.stringify({
  type: "result",
  session_id: "sess-abc",
  result: "Renamed the helper and updated its two call sites."
});
const CURSOR_COMMAND = ["cursor-agent", "-p", "rename the helper", "--output-format", "json"];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "watch-activity-"));
  cleanEnv = { COMPACTION_CONFIG_DIR: await mkdtemp(join(tmpdir(), "watch-activity-cfg-")) };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(cleanEnv.COMPACTION_CONFIG_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("watch --once surfaces local activity records for the non-gateway surfaces", () => {
  it("renders a REAL Cursor shim capture at its honest LOCAL-ESTIMATE tier (never provider-reported)", async () => {
    const bridged = await bridgeCursorShimActivity({ rawOutput: CURSOR_OUTPUT, commandParts: CURSOR_COMMAND, cwd: dir });
    expect(bridged.result.appended, "the capture bridge did not append - the test proves nothing").toBe(true);

    const lines: string[] = [];
    await runWatchOnce({ once: true }, { cwd: dir, env: cleanEnv as NodeJS.ProcessEnv, print: (l) => lines.push(l) });
    const turns = lines.filter((l) => l.startsWith("compaction · "));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain("cursor");
    expect(turns[0]).toContain("local-estimate");
    expect(turns[0]).toMatch(/output \d+ \(local-estimate\)/);
    // NEVER relabelled as provider-reported, and never a savings/cost figure.
    expect(turns[0]).not.toContain("provider-reported");
    expect(turns[0]).not.toMatch(/\$\d/);
    expect(turns[0]).not.toMatch(/−\d+%/);
  });

  it("says so when a turn has no usable token axis, instead of printing a zero", async () => {
    // No separable `result` and no declared prompt → BOTH axes unavailable-with-reason.
    const bridged = await bridgeCursorShimActivity({ rawOutput: "not json at all", cwd: dir });
    expect(bridged.result.appended).toBe(true);
    const lines: string[] = [];
    await runWatchOnce({ once: true }, { cwd: dir, env: cleanEnv as NodeJS.ProcessEnv, print: (l) => lines.push(l) });
    const turns = lines.filter((l) => l.startsWith("compaction · "));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain("no token axis reported");
    expect(turns[0]).not.toMatch(/output 0\b/);
    expect(turns[0]).not.toMatch(/input 0\b/);
  });

  /**
   * CODEX ACTIVITY IS DELIBERATELY NOT READ. The documented routed command this flow's own ready
   * screen prints is `compaction gateway run -- codex …`; the child inherits PATH, PATH is where the
   * capture shim lives, so ONE routed run appends an activity event AND writes a gateway receipt.
   * Reading both stores for Codex prints that turn twice, and a doubled feed is a worse lie than a
   * missing one. Codex keeps its Stop-hook line and its gateway receipts.
   */
  it("does NOT render a captured Codex run (it would double-print against the gateway receipt)", async () => {
    const codexOutput = [
      JSON.stringify({ type: "thread.started", thread_id: "th_1" }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1200, output_tokens: 340, cached_input_tokens: 0 }
      })
    ].join("\n");
    const bridged = await bridgeCodexShimActivity({ rawOutput: codexOutput, cwd: dir });
    expect(bridged.result.appended, "the codex bridge did not append - the test proves nothing").toBe(true);
    const lines: string[] = [];
    await runWatchOnce({ once: true }, { cwd: dir, env: cleanEnv as NodeJS.ProcessEnv, print: (l) => lines.push(l) });
    expect(lines.filter((l) => l.startsWith("compaction · "))).toEqual([]);
  });

  it("headers name the sources HONESTLY, state the Cursor tier, and say what is NOT measured", async () => {
    const once = (await watchOnceHeaderLines(cleanEnv as NodeJS.ProcessEnv)).join("\n");
    const live = (await watchHeaderLines(false, cleanEnv as NodeJS.ProcessEnv)).join("\n");
    for (const header of [once, live]) {
      // Scoped to the measurable form, not "Cursor runs" in general (the IDE session is shaped but
      // never measured, so it can never appear here).
      expect(header).toContain("Cursor runs captured by the shim: `cursor-agent … --output-format json`");
      expect(header).toContain("Interactive sessions are not measured and do not appear here");
      expect(header).toContain("Cursor is local-estimate only");
      expect(header).toContain("never provider-reported");
      // The old unqualified claim must not come back.
      expect(header).not.toContain("captured Codex runs)");
    }
  });

  it("the empty state names the MEASURABLE forms, not 'a Cursor/Codex session'", async () => {
    const lines: string[] = [];
    await runWatchOnce({ once: true }, { cwd: dir, env: cleanEnv as NodeJS.ProcessEnv, print: (l) => lines.push(l) });
    const text = lines.join("\n");
    expect(text).toContain("codex exec --json");
    expect(text).toContain("cursor-agent … --output-format json");
    expect(text).toContain("Interactive sessions are not measured");
    expect(text).not.toContain("a Cursor/Codex session");
  });
});

describe("the live watch loop follows the activity store as well as the gateway receipts", () => {
  it("prints a Cursor turn that lands AFTER the watch started", async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    const run = runWatch(controller.signal, {}, {
      cwd: dir,
      env: cleanEnv as NodeJS.ProcessEnv,
      print: (l) => lines.push(l),
      pollMs: 25
    });
    await new Promise((r) => setTimeout(r, 60));
    await bridgeCursorShimActivity({ rawOutput: CURSOR_OUTPUT, commandParts: CURSOR_COMMAND, cwd: dir });
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await run;
    const turns = lines.filter((l) => l.startsWith("compaction · "));
    expect(turns.length, "the live feed never printed the Cursor turn").toBeGreaterThanOrEqual(1);
    expect(turns.some((l) => l.includes("cursor") && l.includes("local-estimate"))).toBe(true);
    // Exactly once — a second drain must not re-print a turn it already emitted.
    expect(turns.filter((l) => l.includes("cursor"))).toHaveLength(1);
  });
});

/**
 * CROSS-STORE RECENCY. `watch` used to concatenate ALL gateway lines and then ALL activity lines and
 * only then slice the tail — which is not a time order across two independent append-only files. So
 * `--once -n 1` returned an OLD Cursor capture while a NEWER gateway receipt sat right there.
 *
 * The ordering fact is asymmetric and the fix has to respect that: a gateway receipt carries
 * `captured_at`; a metrics-only activity event carries NO wall-clock at all (the content-free
 * allowlist has no time field). So dated records sort by their own time, and an undated record is
 * never allowed to occupy the NEWEST slot — "newest" is a recency claim, and there is no evidence
 * for it.
 */
describe("cross-store recency: the newest line is chosen by recorded time, not by read order", () => {
  /** A gateway receipt with an explicit `captured_at`, written straight to the receipts store. */
  async function appendReceipt(id: string, capturedAt: string, output: number): Promise<void> {
    const receipt = {
      receipt_id: id,
      captured_at: capturedAt,
      provider: "anthropic",
      model: "m",
      endpoint: "/v1/messages",
      mode: "record",
      upstream_status: 200,
      model_visible_bytes_changed: false,
      tokens: { prompt_input: 100, output },
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
    await mkdir(join(dir, ".compaction", "gateway"), { recursive: true });
    await appendFile(join(dir, ".compaction", "gateway", "receipts.jsonl"), `${JSON.stringify(receipt)}\n`, "utf8");
  }

  it("an OLD Cursor capture does NOT outrank a NEWER gateway receipt for `--once -n 1`", async () => {
    // Cursor turn happens FIRST (and its store records no time at all)…
    await bridgeCursorShimActivity({ rawOutput: CURSOR_OUTPUT, commandParts: CURSOR_COMMAND, cwd: dir });
    // …then a gateway-routed turn, which DOES carry a recorded timestamp.
    await appendReceipt("newer-gateway", "2026-08-10T12:00:00.000Z", 777);

    const lines: string[] = [];
    await runWatchOnce({ once: true, lines: 1 }, { cwd: dir, env: cleanEnv as NodeJS.ProcessEnv, print: (l) => lines.push(l) });
    const turns = lines.filter((l) => l.startsWith("compaction · "));
    expect(turns).toHaveLength(1);
    expect(turns[0], "the OLD undated Cursor capture was presented as the newest turn").toContain("777");
    expect(turns[0]).not.toContain("cursor");
  });

  it("orders the whole feed oldest-first: undated captures, then dated receipts by their own time", async () => {
    await bridgeCursorShimActivity({ rawOutput: CURSOR_OUTPUT, commandParts: CURSOR_COMMAND, cwd: dir });
    // Appended out of order on purpose: the file order must NOT decide the feed order.
    await appendReceipt("later", "2026-08-10T12:00:00.000Z", 222);
    await appendReceipt("earlier", "2026-08-10T09:00:00.000Z", 111);

    const lines: string[] = [];
    await runWatchOnce({ once: true, all: true }, { cwd: dir, env: cleanEnv as NodeJS.ProcessEnv, print: (l) => lines.push(l) });
    const turns = lines.filter((l) => l.startsWith("compaction · "));
    expect(turns).toHaveLength(3);
    expect(turns[0]).toContain("cursor"); // undated: never the newest
    expect(turns[1]).toContain("111"); // 09:00 before…
    expect(turns[2]).toContain("222"); // …12:00, regardless of append order
  });

  it("`lastReceiptLines(1)` (the `compaction status` surface) picks the same newest line", async () => {
    await bridgeCursorShimActivity({ rawOutput: CURSOR_OUTPUT, commandParts: CURSOR_COMMAND, cwd: dir });
    await appendReceipt("newest", "2026-08-10T12:00:00.000Z", 999);
    const { lines, killSwitch } = await lastReceiptLines(1, { cwd: dir, env: cleanEnv as NodeJS.ProcessEnv });
    expect(killSwitch).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("999");
  });

  it("a receipt with an unreadable `captured_at` is treated as UNDATED, never as `now`", async () => {
    await appendReceipt("bad-clock", "not-a-timestamp", 555);
    await appendReceipt("good-clock", "2026-08-10T12:00:00.000Z", 666);
    const lines: string[] = [];
    await runWatchOnce({ once: true, all: true }, { cwd: dir, env: cleanEnv as NodeJS.ProcessEnv, print: (l) => lines.push(l) });
    const turns = lines.filter((l) => l.startsWith("compaction · "));
    expect(turns).toHaveLength(2);
    expect(turns[0]).toContain("555"); // undated sorts before every dated record
    expect(turns[1]).toContain("666");
  });
});

describe("the activity feed is scoped so no turn is printed twice", () => {
  it("covers CURSOR ONLY - claude_code and codex both have a gateway receipt that would double-print", () => {
    expect([...WATCH_ACTIVITY_SURFACES]).toEqual(["cursor"]);
    for (const surface of ["claude_code", "codex"]) {
      const event = JSON.stringify({
        activity_event_id: `act-${surface}`,
        surface,
        provider: "anthropic",
        output_after: 400,
        token_source: { output: { source: "provider-reported" } }
      });
      expect(activityLinesFromJsonl(event), `${surface} must not be rendered from the activity store`).toEqual([]);
    }
  });

  it("skips blank and malformed lines rather than throwing", () => {
    expect(activityLinesFromJsonl("\n\nnot json\n{}\n")).toEqual([]);
  });
});
