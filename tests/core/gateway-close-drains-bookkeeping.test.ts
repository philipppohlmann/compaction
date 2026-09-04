/**
 * The gateway's bookkeeping writes (the content-free receipt append, the auto-apply activity append)
 * are DETACHED from the request path on purpose: a proxied response must never wait on a local file
 * write. Nothing, however, waited on them either — `server.close()` returned while a write was still
 * in flight, and `compaction gateway`'s SIGINT handler follows `close()` with `process.exit(0)`
 * (`src/cli/commands/gateway.ts`), so pressing Ctrl-C straight after a turn could discard that turn's
 * receipt. These tests pin both halves of the contract:
 *
 *  - the response still does NOT wait for the write (`track()` is not an await in disguise), and
 *  - `close()` DOES wait for it, bounded and failure-tolerant, so the last turn's receipt survives.
 *
 * The reproduction is deterministic rather than timing-dependent: `appendGatewayReceipt` is mocked to
 * delay a fixed interval before calling through to the real implementation, which puts the write
 * reliably in flight at the moment `close()` is called. That same in-flight write is what intermittently
 * reddened `tests/core/engine-apply-fail-open.test.ts` in CI — the real `appendGatewayReceipt`
 * `mkdir`s `.compaction/gateway` recursively, so a write landing after the test's `rmSync` RECREATES
 * the tree it just deleted (ENOTEMPTY when it lands mid-rmdir). The last case reproduces exactly that
 * harness, so the fix is proven against the failure it was written for, not against an analogue.
 */
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the (hoisted) `vi.mock` factory below can close over it while each test still controls
// the delay and reads the call counters.
const appendHook = vi.hoisted(() => ({
  delayMs: 0,
  /** Reject instead of writing — the "a bookkeeping write throws" case. */
  reject: false,
  /**
   * Delay inside `usageTee.finish()`, which `runEnd` awaits BEFORE it starts any bookkeeping write.
   * Not a synthetic hazard: for any compressed upstream response the real `finish()` waits on a zlib
   * `end`/`error` event (`usage-response-tee.ts`), so this window genuinely exists in production.
   */
  teeFinishDelayMs: 0,
  started: 0,
  finished: 0
}));

vi.mock("../../src/core/gateway/receipt.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/core/gateway/receipt.js")>(
    "../../src/core/gateway/receipt.js"
  );
  return {
    ...actual,
    appendGatewayReceipt: async (receipt: Parameters<typeof actual.appendGatewayReceipt>[0], cwd?: string) => {
      appendHook.started += 1;
      await new Promise((resolve) => setTimeout(resolve, appendHook.delayMs));
      if (appendHook.reject) {
        appendHook.finished += 1;
        throw new Error("bookkeeping write failed (test)");
      }
      const file = await actual.appendGatewayReceipt(receipt, cwd);
      appendHook.finished += 1;
      return file;
    }
  };
});

vi.mock("../../src/core/gateway/usage-response-tee.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/core/gateway/usage-response-tee.js")>(
    "../../src/core/gateway/usage-response-tee.js"
  );
  return {
    ...actual,
    createUsageTee: (...args: Parameters<typeof actual.createUsageTee>) => {
      const tee = actual.createUsageTee(...args);
      return {
        push: (chunk: Buffer) => tee.push(chunk),
        finish: async () => {
          await new Promise((resolve) => setTimeout(resolve, appendHook.teeFinishDelayMs));
          return tee.finish();
        }
      };
    }
  };
});

import { createGatewayServer } from "../../src/core/gateway/server.js";
import { PendingBookkeeping } from "../../src/core/gateway/pending-bookkeeping.js";
import { AUTO_APPLY_ELIGIBILITY_GATES, savePolicyPreference } from "../../src/core/policy-preferences.js";
import { DEDUPE_POLICY } from "../../src/core/gateway/request-shape.js";
import { ENGINE_PATH_ENV } from "../../src/core/gateway/engine-ipc/supervisor.js";

const RECEIPTS = join(".compaction", "gateway", "receipts.jsonl");
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  appendHook.delayMs = 0;
  appendHook.reject = false;
  appendHook.teeFinishDelayMs = 0;
  appendHook.started = 0;
  appendHook.finished = 0;
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A real gateway over a local fake upstream. `storedAuthorization` reproduces the exact shape of
 * `engine-apply-fail-open.test.ts` (codex workflow, cache+context, a stored auto-apply preference and
 * an engine path that cannot resolve → every apply degrades fail-open to a plain record receipt).
 */
async function harness(opts: { storedAuthorization?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "gw-drain-"));
  // The DEVICE store, deliberately NOT under `cwd`: the gateway reads the authorization from the
  // device environment alone, so a fixture that wrote it into the working directory would now be
  // asserting the very thing that must not work (repository content granting apply).
  const deviceDir = mkdtempSync(join(tmpdir(), "gw-drain-device-"));
  const upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 20 } }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;

  if (opts.storedAuthorization) {
    await savePolicyPreference(
      {
        scope: { tool: "codex", policy_type: DEDUPE_POLICY },
        preference: "auto-when-gates-pass",
        gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
      },
      deviceDir
    );
  }

  const gateway = createGatewayServer({
    provider: "openai",
    upstream: `http://127.0.0.1:${upstreamPort}`,
    mode: "record",
    cwd,
    entitlementEnv: { COMPACTION_CONFIG_DIR: deviceDir },
    ...(opts.storedAuthorization
      ? { workflow: "codex", optimizationMode: "cache-plus-context" as const }
      : {})
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayPort = (gateway.address() as { port: number }).port;

  let closed = false;
  const close = () =>
    new Promise<void>((resolve) => {
      closed = true;
      gateway.close(() => resolve());
    });
  cleanups.push(async () => {
    if (!closed) await close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const post = (body: string) =>
    new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: gatewayPort,
          path: "/v1/responses",
          method: "POST",
          headers: { "content-type": "application/json" },
          agent: false // no keep-alive: the socket closes with the response, so close() is not held open
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve());
        }
      );
      req.on("error", reject);
      req.end(body);
    });

  return { cwd, post, close, gateway };
}

const BIG = "R".repeat(700);
const DUPLICATED_BODY = JSON.stringify({ input: `${BIG}\n\n${BIG}` });

describe("gateway close() drains pending bookkeeping writes", () => {
  it("the proxied response does NOT wait for the receipt write", async () => {
    // A delay far longer than any plausible proxy hop. If the response awaited the write, the client
    // could not possibly return before it finished.
    appendHook.delayMs = 500;
    const h = await harness();

    await h.post(JSON.stringify({ input: "hello" }));

    // Structural, NOT a stopwatch: at the moment the client already holds its COMPLETE response the
    // write has not finished and nothing is on disk. A wall-clock bound ("the response returned in
    // under N ms") would prove the same thing less reliably — it flakes on a loaded CI worker, which
    // is precisely the failure mode this test exists to rule out.
    expect(appendHook.finished).toBe(0);
    expect(existsSync(join(h.cwd, RECEIPTS))).toBe(false);

    // ...and the write is real and lands afterwards, so what the response skipped was the WAIT, not
    // the work. (Deliberately asserted here too: a "fast response" that silently dropped the receipt
    // would otherwise satisfy every assertion above.)
    await h.close();
    expect(appendHook.finished).toBe(1);
  });

  it("close() does not drop the last turn's receipt", async () => {
    appendHook.delayMs = 300;
    const h = await harness();
    await h.post(JSON.stringify({ input: "hello" }));
    expect(appendHook.finished).toBe(0); // still in flight when close() is called

    await h.close();

    // The receipt for the turn that just ran is on disk BY THE TIME close() resolves. This is the
    // product guarantee: `compaction gateway`'s SIGINT handler calls close() and then process.exit(0),
    // so anything not durable here is gone.
    expect(appendHook.finished).toBe(1);
    const lines = readFileSync(join(h.cwd, RECEIPTS), "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it("close() waits even when the write has not started yet", async () => {
    // The narrow window the append-level tracking alone cannot see: `runEnd` awaits the usage window
    // (a zlib flush on any compressed response) BEFORE it starts a single bookkeeping write, so at
    // `close()` there is nothing appended to wait for — only the work that will start one.
    appendHook.teeFinishDelayMs = 300;
    appendHook.delayMs = 0;
    const h = await harness();
    await h.post(JSON.stringify({ input: "hello" }));
    expect(appendHook.started).toBe(0); // the write has not begun; this is the window

    await h.close();

    expect(appendHook.finished).toBe(1);
    const lines = readFileSync(join(h.cwd, RECEIPTS), "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it("close() is safe with nothing pending, when a write throws, and when called twice", async () => {
    // Nothing pending: no request was ever made.
    const idle = await harness();
    await idle.close();

    // A throwing write must not hang or reject close() — a dropped receipt turning into a hung
    // shutdown is a strictly worse trade than the bug this drain fixes.
    appendHook.delayMs = 150;
    appendHook.reject = true;
    const throwing = await harness();
    await throwing.post(JSON.stringify({ input: "hello" }));
    await expect(throwing.close()).resolves.toBeUndefined();
    expect(appendHook.finished).toBe(1); // the write ran and rejected; close() still completed
    expect(existsSync(join(throwing.cwd, RECEIPTS))).toBe(false);

    // Double close: the second call resolves too (node reports ERR_SERVER_NOT_RUNNING to the callback,
    // which the drain passes through unchanged rather than swallowing or hanging on).
    await expect(throwing.close()).resolves.toBeUndefined();
  });

  it("CONCURRENT drains each wait for the full set", async () => {
    // The case sequential coverage misses. A drain observes the pending set; it must not TAKE it, or
    // a second drain running at the same time sees nothing and returns instantly.
    const pending = new PendingBookkeeping();
    let release = (): void => {};
    let done = false;
    pending.track(new Promise<void>((resolve) => { release = resolve; }).then(() => { done = true; }));

    let firstDone = false;
    let secondDone = false;
    const first = pending.drain(2_000).then(() => { firstDone = true; });
    const second = pending.drain(2_000).then(() => { secondDone = true; });

    // Neither may resolve while the write is still in flight. Waiting and asserting "not yet" cannot
    // false-fail on a slow machine — a correct drain never resolves before `release()` at any speed;
    // only a drain that emptied the set out from under its peer can.
    await sleep(50);
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(done).toBe(true);
    expect(pending.size).toBe(0);
  });

  it("CONCURRENT close() calls each see the receipt written", async () => {
    // The production shape of the above: gateway.ts registers SIGINT *and* SIGTERM handlers that each
    // run `await close(); process.exit(0)` with no idempotence guard. Two signals arriving together
    // must not let the second one exit over an unwritten receipt.
    appendHook.delayMs = 300;
    const h = await harness();
    await h.post(JSON.stringify({ input: "hello" }));

    const seen: number[] = [];
    await Promise.all([
      new Promise<void>((resolve) => h.gateway.close(() => { seen.push(appendHook.finished); resolve(); })),
      new Promise<void>((resolve) => h.gateway.close(() => { seen.push(appendHook.finished); resolve(); }))
    ]);

    // BOTH callbacks — not just the first — must observe the completed write.
    expect(seen).toHaveLength(2);
    expect(seen).toEqual([1, 1]);
  });

  it("a wedged write is abandoned rather than allowed to hang shutdown", async () => {
    // The trade this drain must never make: a lost receipt is bad, a gateway that will not exit is
    // worse. A write that never settles is given up on at the deadline.
    const pending = new PendingBookkeeping();
    pending.track(new Promise<void>(() => {})); // never settles
    expect(pending.size).toBe(1);

    const startedAt = Date.now();
    await pending.drain(50);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("reproduces the engine-apply-fail-open CI flake: a late write must not resurrect the workspace", async () => {
    // The exact conditions of tests/core/engine-apply-fail-open.test.ts: stored auto-apply
    // authorization + cache-plus-context + an engine path that cannot resolve, so the apply degrades
    // fail-open and the turn lands on the plain record receipt.
    const prev = process.env[ENGINE_PATH_ENV];
    process.env[ENGINE_PATH_ENV] = join(tmpdir(), `definitely-not-an-engine-${Date.now()}.js`);
    try {
      appendHook.delayMs = 300;
      const h = await harness({ storedAuthorization: true });
      await h.post(DUPLICATED_BODY);
      expect(appendHook.finished).toBe(0); // the write is in flight, exactly as in the flaky run

      await h.close();
      rmSync(h.cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

      // Wait out the delay: before the drain existed, the write landed here and its recursive mkdir
      // recreated `<cwd>/.compaction/gateway`, resurrecting the directory the test had just removed.
      // (In CI the same write landed mid-`rmSync` instead, which is the ENOTEMPTY.)
      await sleep(appendHook.delayMs * 3);
      expect(existsSync(h.cwd)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env[ENGINE_PATH_ENV];
      else process.env[ENGINE_PATH_ENV] = prev;
    }
  });
});
