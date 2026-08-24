/**
 * `compaction api export` end-to-end CLI test. Runs the BUILT CLI
 * (`dist/cli/index.js`) in a tmpdir cwd so `.compaction/` never leaks into the repo checkout.
 *
 * Proven here:
 * - `api export --json` on an EMPTY store → valid JSON parseable to the typed document shape, exit 0;
 * - `api export --json` after seeding one content-free receipt → the receipt is carried, still valid JSON;
 * - `--out <file>` writes the JSON to the operator-specified local path (and prints nothing to stdout but a
 *   one-line confirmation); nothing is uploaded.
 *
 * ALL SYNTHETIC + CWD-SCOPED. dist is built by `pretest`.
 */
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sanitizePreviewUrl } from "../../src/core/api-client/payload.js";

const execFileAsync = promisify(execFile);
const CLI = resolve("dist/cli/index.js");

async function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, ...args], { cwd, env });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

async function fakeApi(): Promise<{ server: Server; url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "POST") requests.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ingested", ingest_count: requests.length }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake API did not bind");
  return { server, url: `http://127.0.0.1:${address.port}`, requests };
}

const EXPECTED_KEYS = [
  "schema_version",
  "generated_at",
  "gateway_status",
  "cache_summary",
  "receipts",
  "activity",
  "verifications",
  "capabilities",
  "proof_scopes",
  "plan_lifetime"
].sort();

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "api-export-cli-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("compaction api export", () => {
  it("empty store → valid JSON parseable to the typed document, exit 0", async () => {
    const { stdout, code } = await run(cwd, ["api", "export", "--json"]);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(Object.keys(doc).sort()).toEqual(EXPECTED_KEYS);
    expect(doc.schema_version).toBe("2");
    expect(doc.receipts).toEqual([]);
    expect(Array.isArray(doc.capabilities)).toBe(true);
    expect(doc.capabilities.length).toBeGreaterThan(0);
    // v2: proof_scopes derived from the always-populated matrix; plan_lifetime one record per plan-auth wf.
    expect(Array.isArray(doc.proof_scopes)).toBe(true);
    expect(doc.proof_scopes.length).toBeGreaterThan(0);
    expect(doc.plan_lifetime.map((r: { workflow: string }) => r.workflow).sort()).toEqual([
      "claude-code",
      "codex",
      "cursor"
    ]);
  });

  it("--dashboard-contract emits the typed /app contract (same content-free truth, tiers, local-only)", async () => {
    const { stdout, code } = await run(cwd, ["api", "export", "--dashboard-contract"]);
    expect(code).toBe(0);
    const contract = JSON.parse(stdout);
    expect(contract.schema_version).toBe("2");
    expect(contract.contract_version).toBe("2");
    expect(Array.isArray(contract.proof_scopes)).toBe(true);
    // Every row carries a /app tier and preserves its economic route (Route A vs Route B never conflated).
    for (const row of contract.proof_scopes) {
      expect(["live", "estimated", "fallback"]).toContain(row.tier);
      expect(["plan-lifetime", "api-billing"]).toContain(row.economicRoute);
    }
    expect(contract.ingestion_note).toContain("Local export only");
    // No invoice-confirmed FIGURE/LABEL VALUE is emitted (the ingestion note carries only the honest
    // negation "...no figure is invoice-confirmed"; forbid the string as a JSON value, not in prose).
    const compact = JSON.stringify(JSON.parse(stdout));
    expect(compact).not.toContain(':"invoice-confirmed"');
  });

  it("carries a seeded content-free receipt; still valid JSON", async () => {
    const gw = join(cwd, ".compaction", "gateway");
    await mkdir(gw, { recursive: true });
    const receipt = {
      receipt_id: "r-1",
      captured_at: "2026-07-09T00:00:00.000Z",
      provider: "openai",
      model: "gpt-4o-mini",
      endpoint: "/v1/chat/completions",
      mode: "record",
      upstream_status: 200,
      model_visible_bytes_changed: false,
      tokens: { prompt_input: 1000, cached_input: 400, billed_fresh_input: 600, output: 20 },
      fresh_billed_input_reduction: { available: true, pct: 40, note: "provider-reported" },
      token_source: "provider-reported",
      cache_source: "provider-reported",
      cost_source: "unavailable",
      reasons: { cost: "provider reports tokens, not billing" },
      claim_scope: "run-scoped",
      approval_status: "not-required",
      sync_status: "local-only",
      content_uploaded: false,
      label: "content-free receipt"
    };
    await writeFile(join(gw, "receipts.jsonl"), JSON.stringify(receipt) + "\n", "utf8");

    const { stdout, code } = await run(cwd, ["api", "export", "--json"]);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.receipts).toHaveLength(1);
    expect(doc.gateway_status.receiptsCount).toBe(1);
    expect(doc.cache_summary.bestReduction.available).toBe(true);
  });

  it("--out writes the JSON to the operator-specified local path", async () => {
    const outPath = join(cwd, "export.json");
    const { stdout, code } = await run(cwd, ["api", "export", "--out", outPath]);
    expect(code).toBe(0);
    expect(stdout).toContain(outPath);
    const written = JSON.parse(await readFile(outPath, "utf8"));
    expect(Object.keys(written).sort()).toEqual(EXPECTED_KEYS);
  });

  it("api export --to-api previews without POST, then sends only with --yes and preserves evidence labels", async () => {
    const fake = await fakeApi();
    try {
      const env = { ...process.env, COMPACTION_API_URL: fake.url, COMPACTION_API_KEY: "" };
      const preview = await run(cwd, ["api", "export", "--to-api"], env);
      expect(preview.code).toBe(2);
      expect(preview.stdout).toContain("POST /v0/ingest/export");
      expect(preview.stdout).toContain("content-free dashboard export");
      expect(preview.stdout).toContain("bytes:");
      expect(fake.requests).toHaveLength(0);

      const sent = await run(cwd, ["api", "export", "--to-api", "--yes"], env);
      expect(sent.code).toBe(0);
      expect(fake.requests).toHaveLength(1);
      const body = JSON.parse(fake.requests[0]);
      expect(body.schema_version).toBe("2");
      expect(body.proof_scopes.every((scope: { tierLabel: string }) => typeof scope.tierLabel === "string")).toBe(true);
      expect(JSON.stringify(body)).not.toContain("COMPACTION_API_KEY");
    } finally {
      fake.server.closeAllConnections?.();
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  it("sanitizes preview URLs without changing the request target", () => {
    expect(sanitizePreviewUrl("https://user:secret@example.test:9443/v0/ingest?token=hidden#fragment")).toBe(
      "https://example.test:9443/v0/ingest"
    );
    expect(sanitizePreviewUrl("https://example.test")).toBe("https://example.test/");
  });

  it("api export --to-api refuses a non-local endpoint without a key", async () => {
    const result = await run(cwd, ["api", "export", "--to-api", "--yes", "--url", "https://private.example.test"], {
      ...process.env,
      COMPACTION_API_KEY: ""
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("key is required");
  });
});
