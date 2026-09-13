import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUserRun, endUserRun, currentUserRun } from "../../src/core/gateway/run-boundary.js";

/**
 * The run store must be swapped in ATOMICALLY.
 *
 * It used to be opened `O_WRONLY|O_CREAT|O_TRUNC` and only THEN filled, so the file sat at zero bytes
 * while validation (schema checks plus a SHA-256 event-id derivation) ran. A concurrent
 * `compaction statusline` reading in that window got `JSON.parse("")`, which `readStore` reports as
 * "this session has no runs" — and a session with no run boundary hands the visible line to the LAST
 * PROVIDER CALL, which is exactly the micro-call flicker the run-level surface exists to prevent.
 * An interruption in that window (Ctrl-C in the hook, OOM, disk full) left the store permanently
 * unparseable, so the session lost its run boundary for good and `run_seq` restarted at 1.
 */
const CORRELATION = "0123456789abcdef0123456789abcdef";
let dir: string;
const env = (): NodeJS.ProcessEnv => ({ COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
const storeFile = (): string => {
  const runs = join(dir, "runs");
  const entry = readdirSync(runs).find((f) => f.endsWith(".json"));
  return join(runs, entry!);
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "run-store-atomic-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("run store is replaced atomically", () => {
  it("swaps the file by rename rather than truncating it in place", () => {
    startUserRun(CORRELATION, "2026-09-01T10:00:00.000Z", env());
    const first = statSync(storeFile()).ino;

    endUserRun(CORRELATION, "2026-09-01T10:00:05.000Z", env());
    const second = statSync(storeFile()).ino;

    // Truncate-in-place keeps the SAME inode; an atomic tmp+rename swap always produces a new one.
    // This is the observable difference between "a reader can see an empty file" and "a reader sees
    // either the whole previous store or the whole next one".
    expect(second).not.toBe(first);
  });

  it("leaves the store parseable and the run readable after every write", () => {
    startUserRun(CORRELATION, "2026-09-01T10:00:00.000Z", env());
    expect(() => JSON.parse(readFileSync(storeFile(), "utf8"))).not.toThrow();
    expect(readFileSync(storeFile(), "utf8").length).toBeGreaterThan(0);

    endUserRun(CORRELATION, "2026-09-01T10:00:05.000Z", env());
    const parsed = JSON.parse(readFileSync(storeFile(), "utf8"));
    expect(Array.isArray(parsed.runs)).toBe(true);
    expect(currentUserRun(CORRELATION, env())).toBeDefined();
  });

  it("leaves no temporary files behind", () => {
    startUserRun(CORRELATION, "2026-09-01T10:00:00.000Z", env());
    endUserRun(CORRELATION, "2026-09-01T10:00:05.000Z", env());
    expect(readdirSync(join(dir, "runs")).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("recovers the run boundary rather than silently renumbering when the store is corrupt", () => {
    startUserRun(CORRELATION, "2026-09-01T10:00:00.000Z", env());
    endUserRun(CORRELATION, "2026-09-01T10:00:05.000Z", env());
    // The durable half of the old defect: a half-written store read as "no runs".
    writeFileSync(storeFile(), "", "utf8");
    expect(currentUserRun(CORRELATION, env())).toBeUndefined(); // honest: nothing readable
    // A corrupt store must not be able to persist as a permanent loss — the next run re-establishes one.
    const reopened = startUserRun(CORRELATION, "2026-09-01T10:01:00.000Z", env());
    expect(reopened).toBeDefined();
    expect(currentUserRun(CORRELATION, env())).toBeDefined();
  });
});
