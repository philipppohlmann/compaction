import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeDedupKey } from "../../src/core/claude-code-hook-record.js";

const REPO_ROOT = join(__dirname, "..", "..");

function trackedSourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT })
    .toString("utf8")
    .split("\0")
    .filter((path) => /\.(?:ts|tsx|js|mjs)$/.test(path));
}

describe("tracked source text integrity", () => {
  it("contains no literal NUL bytes", () => {
    const files = trackedSourceFiles();
    expect(files.length).toBeGreaterThan(100);

    const offenders = files.filter((path) => readFileSync(join(REPO_ROOT, path)).includes(0));
    expect(offenders).toEqual([]);
  });

  it("keeps the Claude Code dedup separator byte-compatible", () => {
    expect(
      computeDedupKey({
        sessionId: "s1",
        fingerprint: "abc123",
        messageCount: 10,
        inputTokens: 100,
        outputTokens: 50,
      }),
    ).toBe("9c4fb12e502baef7aebb48c6cd379d70");
  });
});
