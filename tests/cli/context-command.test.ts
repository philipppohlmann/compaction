import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const CLI = path.resolve("dist/cli/index.js");

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec("node", [CLI, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

let dir = "";
let store = "";
let tracePath = "";

const trace = {
  id: "ctx-cmd",
  title: "session",
  artifactVersion: "agent-trace-v1",
  source: "fixture",
  createdAt: "2026-06-24T00:00:00.000Z",
  generatedAt: "2026-06-24T00:00:00.000Z",
  model: "test-model",
  messages: [
    { id: "m1", role: "user", content: "refresh the auth token before the batch upload" },
    { id: "m2", role: "assistant", content: "noted: rotate the signing key during deploy" }
  ]
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ctx-cmd-"));
  store = path.join(dir, "store");
  tracePath = path.join(dir, "trace.json");
  await writeFile(tracePath, JSON.stringify(trace));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("compaction context add", () => {
  it("derives items from a local trace and reports added/skipped/evicted honestly", async () => {
    const { stdout, code } = await runCli(["context", "add", tracePath, "--store-dir", store]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Items added:\s*2\b/);
    expect(stdout).toMatch(/Store now holds:\s*2 items/);
    expect(stdout).toContain("makes no savings claim");
  });

  it("is idempotent on re-add (all duplicates skipped)", async () => {
    const { stdout } = await runCli(["context", "add", tracePath, "--store-dir", store]);
    expect(stdout).toMatch(/Items added:\s*0\b/);
    expect(stdout).toMatch(/skipped \(duplicate\):\s*2\b/);
  });

  it("rejects a non-AgentTrace artifact with a clear error", async () => {
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ not: "a trace" }));
    const { code, stderr } = await runCli(["context", "add", bad, "--store-dir", store]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/Not a normalized AgentTrace/);
  });

  it("rejects a malformed trace whose message lacks string content", async () => {
    const malformed = path.join(dir, "malformed.json");
    await writeFile(malformed, JSON.stringify({ id: "x", messages: [{ id: "m1" }] }));
    const { code, stderr } = await runCli(["context", "add", malformed, "--store-dir", store]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/Malformed trace/);
  });
});

describe("compaction context get", () => {
  it("retrieves + assembles with source pointers and local diagnostics (no quality score)", async () => {
    const { stdout, code } = await runCli([
      "context",
      "get",
      "how do we handle the auth token before upload",
      "--store-dir",
      store
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("[trace=ctx-cmd message=m1]");
    expect(stdout).toMatch(/Diagnostics \(local retrieval, not a quality score\)/);
    expect(stdout).toMatch(/recoverable \(has source pointer\):\s*\d+\/\d+/);
    expect(stdout).toContain("makes no savings claim");
  });

  it("reports a coverage figure only when --source is given", async () => {
    const withSource = await runCli([
      "context",
      "get",
      "auth token",
      "--store-dir",
      store,
      "--source",
      "trace=ctx-cmd message=m1"
    ]);
    expect(withSource.stdout).toMatch(/source coverage:\s*1\/1/);
    const without = await runCli(["context", "get", "auth token", "--store-dir", store]);
    expect(without.stdout).toMatch(/source coverage: n\/a/);
  });

  it("handles an empty / no-match store gracefully (exit 0, honest message)", async () => {
    const emptyStore = path.join(dir, "empty");
    const { stdout, code } = await runCli(["context", "get", "anything", "--store-dir", emptyStore]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/no matching context/i);
  });

  it("rejects an invalid --budget with a clear error (not a misleading no-match)", async () => {
    const { code, stderr } = await runCli([
      "context",
      "get",
      "auth token",
      "--store-dir",
      store,
      "--budget",
      "notanumber"
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--budget must be a non-negative integer/);
  });

  it("rejects an invalid --limit with a clear error", async () => {
    const { code, stderr } = await runCli([
      "context",
      "get",
      "auth token",
      "--store-dir",
      store,
      "--limit",
      "nope"
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--limit must be a non-negative integer/);
  });
});
