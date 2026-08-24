import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const pkgVersion: string = createRequire(import.meta.url)("../../package.json").version;

describe("compaction --version", () => {
  it("reports the real package.json version (never a stale hardcode)", async () => {
    const { stdout } = await run("node", ["dist/cli/index.js", "--version"]);
    expect(stdout.trim()).toBe(pkgVersion);
  });
});
