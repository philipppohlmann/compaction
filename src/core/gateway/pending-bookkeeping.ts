/**
 * Pending BOOKKEEPING work for one gateway server, and the drain its `close()` awaits (public
 * CLI/SDK core; engine-free).
 *
 * The receipt append and the auto-apply activity append are DETACHED from the request path on
 * purpose: a proxied response must never wait on a local file write, so `handleProxy` starts them
 * and moves on. Nothing waited on them afterwards either, which is the defect this module closes —
 * `server.close()` returned while a write was still in flight, and `compaction gateway`'s SIGINT and
 * SIGTERM handlers each follow `close()` with `process.exit(0)`, so pressing Ctrl-C straight after a
 * turn could discard that turn's receipt.
 *
 * IDLE AUTO-SHUTDOWN IS NOT ONE OF THE AFFECTED CALLERS, despite also closing the server.
 * `attachIdleShutdown` calls `server.close()` with NO callback and then fires `onIdleShutdown`
 * synchronously, so the drain runs but nothing waits for it — and that is fine, because unlike the
 * signal handlers that path does not `process.exit()`, so an in-flight write still lands on its own.
 * The drain neither helps nor harms there; it is the `process.exit(0)` that makes a caller vulnerable.
 *
 * The detachment is preserved exactly: {@link PendingBookkeeping.track} is synchronous and returns
 * `void`, so there is no promise for the request path to accidentally await, and it is called at the
 * same statement position the bare `void` was. The only thing added is the shutdown edge.
 *
 * BOUNDED AND FAILURE-TOLERANT BY CONSTRUCTION. Trading a dropped receipt for a gateway that will
 * not exit is a strictly worse deal than the bug being fixed, so a rejected write is swallowed (each
 * write already handles its own errors at the source) and the drain gives up after `timeoutMs`
 * rather than waiting forever on a wedged filesystem. Draining with nothing pending resolves
 * immediately; draining twice — SEQUENTIALLY OR CONCURRENTLY — is safe (see {@link
 * PendingBookkeeping.drain}).
 */
import type http from "node:http";

/**
 * How long `close()` will wait for in-flight bookkeeping before giving up. Long enough for a local
 * append (the writes are small JSONL lines under `.compaction/`), short enough that a wedged write
 * never turns Ctrl-C into a hang.
 *
 * WHAT GIVING UP COSTS, stated rather than left implicit: an abandoned write is not cancelled. It may
 * still land after `close()` has returned, and `appendGatewayReceipt` re-creates `.compaction/gateway`
 * with a recursive `mkdir` — so inside this window the write-after-teardown hazard is exactly the one
 * this module otherwise removes (a workspace deleted after close can be re-created; concurrently, an
 * `rmdir` can see `ENOTEMPTY`). That is the deliberate trade: a hung shutdown is worse than a late
 * write, and only a filesystem wedged for longer than this ceiling can reach it.
 */
export const DEFAULT_BOOKKEEPING_DRAIN_MS = 2_000;

/** The set of detached bookkeeping writes still in flight for one gateway server. */
export class PendingBookkeeping {
  private readonly pending = new Set<Promise<void>>();

  /**
   * Register detached bookkeeping work so `close()` can wait for it.
   *
   * Deliberately synchronous and `void`-returning: it must be a drop-in for the bare `void
   * someWrite()` it replaces on the request path, and it must be impossible for a caller to turn it
   * into an await. Rejections are neutralized here rather than propagated, so a failing write can
   * never surface as an unhandled rejection nor as a rejected drain.
   */
  track(work: Promise<unknown>): void {
    const settled = work.then(
      () => {},
      () => {}
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
  }

  /** How many writes are still in flight (observability + tests). */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Wait for everything currently in flight, and for anything a draining write starts in turn, up to
   * `timeoutMs` total. Never rejects.
   *
   * CONCURRENT DRAINS MUST EACH WAIT FOR THE FULL SET. A drain observes the pending set, it does not
   * take ownership of it: the batch is removed only once it has actually SETTLED, never up-front. An
   * earlier version cleared the set before awaiting, which made a second concurrent drain observe an
   * empty set and return instantly — and that is reachable in production, not theoretical.
   * `src/cli/commands/gateway.ts` registers SIGINT and SIGTERM handlers that each run `await
   * close(); process.exit(0)` with no idempotence guard, so two signals arriving before the `'close'`
   * event give the second drain an empty set, and its `process.exit(0)` then discards the very
   * receipt this module exists to keep.
   *
   * Termination: a pass that completes deletes exactly the promises it proved settled, so no promise
   * is ever awaited twice and the loop advances; anything tracked meanwhile is picked up by the next
   * pass under the remaining budget. A pass that times out deletes NOTHING and returns — leaving
   * those entries tracked, so a later drain still waits for them with its own budget rather than
   * inheriting a set someone else emptied. (`track` removes each entry when it settles regardless,
   * so nothing accumulates either way.)
   */
  async drain(timeoutMs: number = DEFAULT_BOOKKEEPING_DRAIN_MS): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const batch = [...this.pending];
      if (batch.length === 0) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const completed = await Promise.race([Promise.all(batch).then(() => true), timeout(remaining).then(() => false)]);
      // Timed out: shutdown proceeds without these writes. They stay tracked (see above) and may
      // still land afterwards — the caller's own limitation, not something to hide by clearing.
      if (!completed) return;
      for (const settled of batch) this.pending.delete(settled);
    }
  }
}

/** A timer that can never itself be the reason the process stays alive. */
function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Make `server.close()` wait for pending bookkeeping before its callback fires.
 *
 * WHY WRAP `close` RATHER THAN EXPOSE A `drain()` FOR CALLERS TO REMEMBER. Every caller that stops a
 * gateway already calls `close()` — the CLI's SIGINT/SIGTERM handlers, `startGatewayServer`'s
 * returned `close`, and the tests. A separate method would fix only the callers that were updated,
 * and the whole failure mode is a write nobody remembered to wait for. (Idle auto-shutdown closes
 * too, but passes no callback and does not `process.exit()`, so it was never at risk — see the
 * module header.)
 *
 * ORDERING (why in-flight requests are covered too). `server.close(cb)` fires `cb` only after every
 * connection has ended. `handleProxy` registers one response-settlement promise before it starts
 * piping any response byte. EOF or bounded authoritative Codex terminal-event evidence then starts
 * the receipt work behind that promise. A request in flight when `close()` is called is therefore
 * already visible to the drain before the close callback can observe the connection as gone.
 *
 * The callback's `err` (node reports `ERR_SERVER_NOT_RUNNING` on a second `close`) is passed through
 * unchanged; the drain neither swallows it nor adds one of its own.
 */
export function attachBookkeepingDrain(
  server: http.Server,
  pending: PendingBookkeeping,
  timeoutMs: number = DEFAULT_BOOKKEEPING_DRAIN_MS
): void {
  const closeServer = server.close.bind(server);
  server.close = function close(this: http.Server, callback?: (err?: Error) => void): http.Server {
    closeServer((err?: Error) => {
      void pending.drain(timeoutMs).then(() => callback?.(err));
    });
    return this;
  };
}
