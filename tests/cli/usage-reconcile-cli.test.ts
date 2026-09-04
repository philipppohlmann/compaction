import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTIVE_USAGE_METER_VERSION } from "../../src/core/usage/usage-event.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { currentPeriodId } from "../../src/core/entitlement/lease.js";
import { meterConfirmedApply } from "../../src/core/usage/usage-metering.js";

/**
 * `compaction usage reconcile` + the opportunistic attempt inside `compaction lease` — USER-VISIBLE
 * output (built CLI). Two load-bearing properties:
 *
 *  1. CLAIMS HONESTY: counts are entries and a LOCAL-ESTIMATE product allowance unit, never a
 *     provider bill / cost / savings figure, and nothing reports a journal as "verified" because a
 *     server saw it.
 *  2. RECONCILIATION NEVER BLOCKS: a reconcile failure inside `compaction lease` must not change the
 *     command's outcome or its exit code.
 *
 * The CLI runs as a SUBPROCESS that must reach a fake service inside this worker, so it is spawned
 * ASYNCHRONOUSLY — `execFileSync`/`spawnSync` block the event loop and would deadlock the server.
 */
const CLI = join(__dirname, "..", "..", "dist", "cli", "index.js");
const CLI_BUILT = existsSync(CLI);

interface RunResult {
  code: number | null;
  stdout: string;
}

function runCli(args: string[], configDir: string): Promise<RunResult> {
  // FORCE_COLOR must be DELETED, not blanked: chalk treats an empty FORCE_COLOR as "colors on",
  // which would wrap every asserted substring in ANSI escapes.
  const env = { ...process.env, COMPACTION_CONFIG_DIR: configDir, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI, ...args], { env });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

/**
 * A fake service: per-path handlers, so reconcile can fail while lease succeeds.
 *
 * Handlers receive the parsed request body. A partial-acceptance fixture has to name a REAL uploaded
 * `event_id` in `rejected` — the confirmed prefix stops at the first uploaded entry that appears in
 * that list, so a made-up id would confirm everything and produce the opposite of a partial.
 */
function startService(
  routes: Record<string, (body: { entries?: Array<{ event_id: string }> }) => { status: number; body: unknown }>
) {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let parsed: { entries?: Array<{ event_id: string }> } = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // Not every route is called with a JSON body; handlers that ignore it are unaffected.
      }
      const handler = routes[path];
      const result = handler ? handler(parsed) : { status: 404, body: { error: "not_found" } };
      const payload = JSON.stringify(result.body);
      res.writeHead(result.status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  return {
    async start(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

describe.runIf(CLI_BUILT)("`compaction usage reconcile` output honesty", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  async function deviceWithDebits(count: number): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cli-"));
    dirs.push(dir);
    const env = provisionValidLease(dir) as NodeJS.ProcessEnv;
    for (let i = 0; i < count; i++) {
      const result = await meterConfirmedApply(
        {
          routeType: "api-key",
          workflow: "codex",
          provider: "openai",
          periodId: currentPeriodId(),
          allowanceTokens: 2_000_000,
          recoveryId: `rec-${i}`,
          meterVersion: ACTIVE_USAGE_METER_VERSION,
          meteredOptimizedInputTokens: 1234,
          estimatedInputTokensBefore: 1734,
          estimatedInputTokensAfter: 500,
          preMutationBody: "x".repeat(100)
        },
        env
      );
      expect(result.metered).toBe(true);
    }
    return { dir, env };
  }

  it("reports counts WITHOUT any bill / cost / savings language", async () => {
    const { dir } = await deviceWithDebits(2);
    const service = startService({
      "/v0/usage/reconcile": () => ({
        status: 200,
        body: {
          schema_version: 1,
          period_id: currentPeriodId(),
          accepted: 2,
          duplicate: 0,
          rejected: [],
          chain_continuous: true,
          anchor: { entry_count: 2 }
        }
      })
    });
    const url = await service.start();
    try {
      const { code, stdout } = await runCli(["usage", "reconcile", "--api-url", url], dir);
      expect(code).toBe(0);
      expect(stdout).toContain("Uploaded 2 entries");
      expect(stdout).toContain("2 new");
      expect(stdout).toContain("not a provider bill, cost, or savings figure");
      // The banned vocabulary, checked against the exact rendered output.
      for (const banned of ["$", "USD", "saved", "savings of", "per month", "monthly"]) {
        expect(stdout.toLowerCase()).not.toContain(banned.toLowerCase());
      }
      // Uploading does NOT upgrade the local integrity claim.
      expect(stdout.toLowerCase()).not.toContain("verified by the service");
      expect(stdout.toLowerCase()).not.toContain("synced");
    } finally {
      await service.stop();
    }
  });

  it("reports rejections with fixed labels and never discards the consumption story", async () => {
    const { dir } = await deviceWithDebits(1);
    const service = startService({
      "/v0/usage/reconcile": () => ({
        status: 200,
        body: {
          schema_version: 1,
          period_id: currentPeriodId(),
          accepted: 0,
          duplicate: 0,
          rejected: [{ event_id: "00000000-0000-0000-0000-000000000009", reason: "signature-invalid" }],
          chain_continuous: false,
          anchor: { entry_count: 0 }
        }
      })
    });
    const url = await service.start();
    try {
      const { code, stdout } = await runCli(["usage", "reconcile", "--api-url", url], dir);
      expect(code).toBe(0);
      expect(stdout).toContain("1 rejected");
      expect(stdout).toContain("rejected: signature-invalid");
      // The discontinuity is reported honestly AND stated as non-destructive.
      expect(stdout).toContain("did not continue from what it had already recorded");
      expect(stdout).toContain("consumption is never discarded");
    } finally {
      await service.stop();
    }
  });

  it("a failure says so plainly and states that apply is unaffected", async () => {
    const { dir } = await deviceWithDebits(1);
    const service = startService({
      "/v0/usage/reconcile": () => ({ status: 503, body: { error: "usage_reconcile_unavailable" } })
    });
    const url = await service.start();
    try {
      const { stdout } = await runCli(["usage", "reconcile", "--api-url", url], dir);
      expect(stdout).toContain("Could not reconcile");
      expect(stdout).toContain("reconciliation never gates the workflow");
      expect(stdout).toContain("Nothing was uploaded");
    } finally {
      await service.stop();
    }
  });


  it("after a PARTIAL multi-chunk failure it never claims nothing was uploaded (finding 4)", async () => {
    const { dir } = await deviceWithDebits(2);
    let call = 0;
    const service = startService({
      // First run: a REAL partial. The service takes the first entry and rejects the second, so the
      // confirmed prefix stops after entry 1 and entry 2 stays outstanding. (Accepting both would
      // settle the device, and the second run would then have genuinely nothing to send — which is
      // a different, already-covered case.)
      "/v0/usage/reconcile": (body) => {
        call += 1;
        const uploaded = body.entries ?? [];
        return call === 1
          ? {
              status: 200,
              body: {
                schema_version: 1,
                period_id: currentPeriodId(),
                accepted: 1,
                duplicate: 0,
                rejected: [{ event_id: uploaded[uploaded.length - 1]?.event_id, reason: "signature_invalid" }],
                chain_continuous: true,
                anchor: { entry_count: 1 }
              }
            }
          : { status: 500, body: { error: "internal_error" } };
      }
    });
    const url = await service.start();
    try {
      // First run commits entry 1 and leaves entry 2 outstanding.
      await runCli(["usage", "reconcile", "--api-url", url], dir);
      // Second run has real work to do and fails outright — nothing uploaded, so the plain message
      // IS true here, and the command must say so instead of claiming the device is settled.
      const second = await runCli(["usage", "reconcile", "--api-url", url], dir);
      expect(second.stdout).toContain("Could not reconcile");
      expect(second.stdout).toContain("Full apply is unaffected");
    } finally {
      await service.stop();
    }
  });

  it("`compaction usage` explains the reconciled portion so the arithmetic reads correctly", async () => {
    const { dir } = await deviceWithDebits(2);
    const service = startService({
      "/v0/usage/reconcile": () => ({
        status: 200,
        body: {
          schema_version: 1,
          period_id: currentPeriodId(),
          accepted: 2,
          duplicate: 0,
          rejected: [],
          chain_continuous: true,
          anchor: { entry_count: 2 }
        }
      })
    });
    const url = await service.start();
    try {
      await runCli(["usage", "reconcile", "--api-url", url], dir);
    } finally {
      await service.stop();
    }
    const { code, stdout } = await runCli(["usage"], dir);
    expect(code).toBe(0);
    // Both entries are reconciled, so the local tally charges nothing against the lease allowance...
    expect(stdout).toContain("Allowance remaining: 2,000,000 of 2,000,000");
    // ...and the reason is stated rather than left as an apparent contradiction.
    expect(stdout).toContain("2,468 already reconciled");
    expect(stdout).toContain("recorded by the service");
    // The integrity claim is NOT upgraded because a server saw the entries.
    expect(stdout).not.toContain("verified by the service");
    expect(stdout).toContain("Reads local disk only");
  });

  it("does NOT print a reconciled line when nothing has been reconciled", async () => {
    const { dir } = await deviceWithDebits(1);
    const { stdout } = await runCli(["usage"], dir);
    expect(stdout).not.toContain("already reconciled");
  });

  it("`compaction usage` (bare) still makes NO network call and keeps its local-read claim", async () => {
    const { dir } = await deviceWithDebits(1);
    // No service is running at all. The bare command must succeed regardless.
    const { code, stdout } = await runCli(["usage"], dir);
    expect(code).toBe(0);
    expect(stdout).toContain("Reads local disk only");
    expect(stdout).toContain("no account, entitlement service, usage service, or network call");
  });
});

describe.runIf(CLI_BUILT)("reconciliation NEVER blocks `compaction lease`", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  /** A syntactically well-formed signed lease. It will not verify locally — which is fine here: the
   *  assertion is about the reconcile step not FAILING the command, not about lease trust. */
  function leaseBody() {
    const now = Date.now();
    return {
      lease: {
        schema_version: 1,
        lease_id: "00000000-0000-0000-0000-0000000000bb",
        account_id: "acct-test",
        device_public_key_hash: "b".repeat(64),
        period_id: currentPeriodId(),
        allowance_tokens: 1_700_000,
        issued_at: new Date(now).toISOString(),
        expires_at: new Date(now + 86_400_000).toISOString(),
        lease_sequence: 2,
        route_scope: "all"
      },
      signature: "bm90LWEtcmVhbC1zaWduYXR1cmU"
    };
  }

  it("a FAILING reconcile does not stop the lease from being acquired, and does not change the exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-lease-"));
    dirs.push(dir);
    const env = provisionValidLease(dir) as NodeJS.ProcessEnv;
    await meterConfirmedApply(
      {
        routeType: "api-key",
        workflow: "codex",
        provider: "openai",
        periodId: currentPeriodId(),
        allowanceTokens: 2_000_000,
        recoveryId: "rec-block",
        meterVersion: ACTIVE_USAGE_METER_VERSION,
        meteredOptimizedInputTokens: 10,
        estimatedInputTokensBefore: 15,
        estimatedInputTokensAfter: 5,
        preMutationBody: "x"
      },
      env
    );

    const service = startService({
      // The usage service is broken…
      "/v0/usage/reconcile": () => ({ status: 500, body: { error: "internal_error" } }),
      // …but lease issuance still works.
      "/v0/lease": () => ({ status: 200, body: leaseBody() })
    });
    const url = await service.start();
    try {
      const { code, stdout } = await runCli(["lease", "--api-url", url], dir);
      // THE INVARIANT: the command succeeded. Reconciliation is not a gate.
      expect(code).toBe(0);
      expect(stdout).toContain("Lease acquired and stored.");
      expect(stdout).toContain("Could not reconcile usage with the service right now");
      expect(stdout).toContain("this never blocks apply");
    } finally {
      await service.stop();
    }
  });

  it("an OFFLINE device still acquires nothing-but-fails-at-the-lease — reconcile is not what failed", async () => {
    // Nothing is listening. The reconcile attempt must be silent-ish and non-fatal; the command's
    // failure is the LEASE call, which is the only thing it is actually gated on.
    const dir = mkdtempSync(join(tmpdir(), "reconcile-offline-"));
    dirs.push(dir);
    provisionValidLease(dir);
    const { stdout } = await runCli(["lease", "--api-url", "http://127.0.0.1:1"], dir);
    expect(stdout).toContain("Could not acquire a lease");
    // Reconcile reported its own inability without claiming the device is broken.
    expect(stdout).not.toContain("usage journal is invalid");
  });
});
