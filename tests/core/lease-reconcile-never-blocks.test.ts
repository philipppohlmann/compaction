/**
 * OPPORTUNISTIC RECONCILE NEVER BLOCKS `compaction lease` (offline policy (a)).
 *
 * `reconcileOpportunistically` is documented as: every failure path collapses to at most one dim
 * line, it never sets an exit code, and it never rethrows — because if it could fail the command,
 * reconciliation would have become a gate on acquiring a lease. PR13a's lazy import inside it
 * rethrew every error that was not a module-not-found, which made the docblock false and put an
 * unreachable-or-defective reconciliation module in front of lease acquisition.
 *
 * This test drives the REAL `compaction lease` command with the reconcile client's import failing for
 * a NON-absence reason and asserts the command still completes.
 *
 * Discriminating: against the pre-fix `main` the command rejects.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { isModuleAbsentError } from "../../src/core/module-absence.js";

const dirs: string[] = [];
let savedExitCode: number | string | null | undefined;

afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  process.exitCode = savedExitCode;
  vi.doUnmock("../../src/core/auth/usage-reconcile-client.js");
  vi.resetModules();
  vi.restoreAllMocks();
});

/** A config dir holding credentials good enough to reach the reconcile step. */
function configDirWithCredentials(): string {
  const dir = mkdtempSync(join(tmpdir(), "lease-reconcile-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({
      schema_version: 1,
      // 127.0.0.1:1 is closed, so lease ACQUISITION fails cleanly after the reconcile step. What is
      // under test is that the command reaches that point at all instead of rejecting before it.
      api_url: "http://127.0.0.1:1",
      account_id: "acct_fake",
      device_id: "dev_fake",
      device_token: "cmpd_fake_token_for_test",
      // NEVER a literal PEM in source, fake or not: the no-committed-secrets scanner matches PEM
      // headers line-by-line and would rightly flag one. Nothing here parses the key — the reader
      // only checks for a non-empty string — so a placeholder is all this fixture needs.
      device_private_key_pem: "x",
      device_public_key: "x",
      created_at: new Date().toISOString()
    }),
    { mode: 0o600 }
  );
  return dir;
}

async function runLease(configDir: string): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const previousConfigDir = process.env.COMPACTION_CONFIG_DIR;
  process.env.COMPACTION_CONFIG_DIR = configDir;
  try {
    const { registerLeaseCommand } = await import("../../src/cli/commands/lease.js");
    const program = new Command();
    program.exitOverride();
    registerLeaseCommand(program);
    await program.parseAsync(["node", "compaction", "lease"]);
  } finally {
    if (previousConfigDir === undefined) delete process.env.COMPACTION_CONFIG_DIR;
    else process.env.COMPACTION_CONFIG_DIR = previousConfigDir;
  }
  return lines;
}

describe("`compaction lease`: opportunistic reconcile never blocks the command", () => {
  it("a NON-absence failure loading the reconcile client is reported, not rethrown", async () => {
    savedExitCode = process.exitCode;
    vi.resetModules();
    vi.doMock("../../src/core/auth/usage-reconcile-client.js", () => {
      throw Object.assign(new Error("injected loader defect"), { code: "EACCES" });
    });

    const lines = await runLease(configDirWithCredentials());

    // The command ran to completion — the assertion that matters. It then failed to ACQUIRE (the
    // host is closed), which is the normal offline outcome and not a reconcile failure.
    expect(lines.join("\n")).toContain("Usage reconciliation could not start on this device");
    expect(lines.join("\n")).toContain("continuing (this never blocks apply)");
  });

  it("the ABSENT case stays silent: the declared expectation matches a real absence error", () => {
    // The silent branch cannot be driven end-to-end here — `vi.doMock` cannot make a module genuinely
    // fail to RESOLVE; a throwing factory is re-wrapped by vitest and arrives without Node's code. So
    // the branch is pinned at the predicate, against the exact specifier + importer the command
    // declares (`private-boundary-seams.test.ts` pins that the declaration matches the import beside it).
    const importerUrl = pathToFileURL(join(__dirname, "..", "..", "src", "cli", "commands", "lease.ts")).href;
    const specifier = "../../core/auth/usage-reconcile-client.js";
    const missing = join(__dirname, "..", "..", "src", "core", "auth", "usage-reconcile-client.js");
    const absent = Object.assign(new Error(`Cannot find module '${missing}'`), {
      code: "ERR_MODULE_NOT_FOUND",
      url: pathToFileURL(missing).href
    });
    expect(isModuleAbsentError(absent, { specifier, importerUrl })).toBe(true);

    // …and a missing dependency OF that present client is NOT absence: it must reach the dim line
    // above rather than being skipped as an excluded capability.
    const nested = join(__dirname, "..", "..", "src", "core", "auth", "some-inner-dependency.js");
    const nestedAbsent = Object.assign(new Error(`Cannot find module '${nested}'`), {
      code: "ERR_MODULE_NOT_FOUND",
      url: pathToFileURL(nested).href
    });
    expect(isModuleAbsentError(nestedAbsent, { specifier, importerUrl })).toBe(false);
  });
});
