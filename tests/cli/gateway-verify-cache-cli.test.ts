import { describe, it, expect } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GatewayCacheVerification } from "../../src/core/gateway/verification-store.js";

/**
 * CLI e2e, `compaction gateway verify-cache`. Exercises the REAL command: it starts
 * its OWN ephemeral gateway, issues a cold + warm request, reads the REAL content-free receipts, runs the REAL
 * proof math, and writes the content-free verification record. The ONLY thing faked is the upstream provider:
 * an in-process fake OpenAI-compatible server that reports cached tokens on the warm request. NO network, NO
 * real keys, NO live provider call. Async `spawn` (NOT spawnSync, the in-worker fake upstream would deadlock).
 */
const CLI = resolve("dist/cli/index.js");
// FAKE markers so the no-committed-secrets scanner never flags these, and to prove content-freeness.
const FAKE_KEY = "sk-fake-verify-cache-key-NEVER-STORED";
const PROMPT_TOKENS = 1200;
const WARM_CACHED = 900; // 900/1200 served from provider cache on the warm request → 75% fresh-input reduction

function upstreamBody(variant: string | undefined, cachedOverride?: number): string {
  const cached = cachedOverride !== undefined ? cachedOverride : variant === "compacted" ? WARM_CACHED : 0;
  return JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion",
    model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: PROMPT_TOKENS,
      completion_tokens: 4,
      total_tokens: PROMPT_TOKENS + 4,
      prompt_tokens_details: { cached_tokens: cached }
    }
  });
}

function startFakeUpstream(respond: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => respond(req, res));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ port: (server.address() as { port: number }).port, close: () => new Promise((c) => server.close(() => c())) })));
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<CliResult> {
  return new Promise((resolve2, reject) => {
    const child = spawn("node", [CLI, ...args], { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolve2({ code: code ?? 0, stdout, stderr }));
    setTimeout(() => reject(new Error(`verify-cache CLI did not exit in time. stdout=${stdout} stderr=${stderr}`)), 25000);
  });
}

/** Base env with any real provider keys STRIPPED (hermetic - the test supplies only fake keys explicitly). */
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_KEY;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function readVerificationsRaw(cwd: string): string {
  const p = join(cwd, ".compaction", "gateway", "verifications.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}
function readVerifications(cwd: string): GatewayCacheVerification[] {
  const raw = readVerificationsRaw(cwd);
  return raw.trim() ? raw.trim().split("\n").map((l) => JSON.parse(l) as GatewayCacheVerification) : [];
}

describe("compaction gateway verify-cache (CLI e2e; real gateway + real proof; fake OpenAI-compatible upstream)", () => {
  it("with an operator key + a provider that reports cached tokens on the warm request → marks live-verified true + writes a content-free record", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gw-verify-cache-ok-"));
    const upstream = await startFakeUpstream((req, res) => {
      const variant = req.headers["x-compaction-proof-variant"] as string | undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(upstreamBody(variant));
    });
    try {
      const res = await runCli(
        ["gateway", "verify-cache", "--provider", "openai", "--upstream", `http://127.0.0.1:${upstream.port}`, "--json"],
        { cwd, env: { ...baseEnv(), OPENAI_API_KEY: FAKE_KEY } }
      );
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.stdout) as { provider: string; verified: boolean; freshInputReductionPercent?: number; proofRunId: string };
      expect(parsed.provider).toBe("openai");
      expect(parsed.verified).toBe(true);
      expect(parsed.freshInputReductionPercent).toBe(75);

      const records = readVerifications(cwd);
      expect(records).toHaveLength(1);
      const rec = records[0];
      expect(rec.provider).toBe("openai");
      expect(rec.verified).toBe(true);
      expect(rec.fresh_input_reduction_percent).toBe(75);
      expect(typeof rec.proof_run_id).toBe("string");
      expect(typeof rec.observed_at).toBe("string");
      expect(rec.reason).toBeUndefined();
      // Content-free: ONLY the allowed fields, no key/content field can ride.
      const allowed = new Set([
        "provider",
        "proof_run_id",
        "verified",
        "fresh_input_reduction_percent",
        "observed_at",
        "reason",
        "provider_priced_cost_impact"
      ]);
      for (const k of Object.keys(rec)) expect(allowed.has(k), k).toBe(true);

      // Route B (api-billing): gpt-4o-mini is priced + both receipts are provider-reported → the content-free
      // provider-priced cost impact is recorded (numbers + a version string + labels; NO key, NO content).
      const impact = rec.provider_priced_cost_impact!;
      expect(impact).toBeDefined();
      const impactAllowed = new Set(["baseline_usd", "warm_usd", "delta_usd", "delta_pct", "pricing_version", "cost_basis", "proof_level"]);
      for (const k of Object.keys(impact)) expect(impactAllowed.has(k), k).toBe(true);
      expect(impact.cost_basis).toBe("provider-usage-and-published-price");
      expect(impact.proof_level).toBe("provider-priced-api");
      expect(typeof impact.pricing_version).toBe("string");
      // Warm request served 900/1200 input from cache → warm cost < baseline cost → positive delta.
      expect(impact.baseline_usd).toBeGreaterThan(impact.warm_usd);
      expect(impact.delta_usd).toBeGreaterThan(0);
      // Provider-priced is NOT invoice-confirmed, no such claim is ever stored on the record.
      expect(JSON.stringify(rec)).not.toContain("invoice");

      // No key / no content anywhere in the record store or the command output.
      const raw = readVerificationsRaw(cwd);
      for (const s of [raw, res.stdout]) {
        expect(s).not.toContain(FAKE_KEY);
        expect(s).not.toContain("Bearer");
        expect(s.toLowerCase()).not.toContain("system");
        expect(s).not.toContain("Compaction cache-verification prefix");
      }

      // Deliverable 3 e2e: `gateway capabilities` now reflects the real verification → openai row liveVerified:true.
      const caps = await runCli(["gateway", "capabilities", "--json"], { cwd, env: baseEnv() });
      expect(caps.code).toBe(0);
      const matrix = JSON.parse(caps.stdout) as Array<{ providerId?: string; liveVerified: boolean; reasons: Record<string, string> }>;
      const openaiRow = matrix.find((r) => r.providerId === "openai");
      expect(openaiRow).toBeDefined();
      expect(openaiRow!.liveVerified).toBe(true);
      expect(openaiRow!.reasons.liveVerified).toBeUndefined();
    } finally {
      await upstream.close();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 30000);

  it("operator A/B → folds a provider-reported NET-BILLED result into the local calibration store (content-free)", async () => {
    // The operator/key-gated A/B path (`verify-cache`) folds its provider-reported net fresh-BILLED proof
    // delta into the local net-billed calibration store that `compaction savings` reads. The gateway picks
    // its usage adapter by UPSTREAM ORIGIN (the Anthropic adapter matches api.anthropic.com; a 127.0.0.1 fake
    // upstream falls back to the default OpenAI adapter), so this e2e exercises the real fold end-to-end
    // through the OpenAI-shaped upstream. The Anthropic-specific net-billed normalization + proof math is
    // proven directly in tests/core/gateway-proof-anthropic-net-billed.test.ts.
    const cwd = mkdtempSync(join(tmpdir(), "gw-verify-cache-net-billed-fold-"));
    const upstream = await startFakeUpstream((req, res) => {
      const variant = req.headers["x-compaction-proof-variant"] as string | undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(upstreamBody(variant)); // warm serves 900/1200 from cache → net-billed fresh 1200 → 300
    });
    try {
      const res = await runCli(
        ["gateway", "verify-cache", "--provider", "openai", "--upstream", `http://127.0.0.1:${upstream.port}`, "--json"],
        // COMPACTION_CONFIG_DIR points the net-billed store at the temp cwd so this run is hermetic.
        { cwd, env: { ...baseEnv(), OPENAI_API_KEY: FAKE_KEY, COMPACTION_CONFIG_DIR: cwd } }
      );
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.stdout) as { provider: string; verified: boolean; freshInputReductionPercent?: number };
      // baseline fresh=1200, warm fresh=300 → net-billed reduction 900/1200 = 75%.
      expect(parsed.verified).toBe(true);
      expect(parsed.freshInputReductionPercent).toBe(75);

      // The NET-BILLED calibration store was written under COMPACTION_CONFIG_DIR, content-free, measured.
      const storePath = join(cwd, "net-billed-calibration.json");
      expect(existsSync(storePath)).toBe(true);
      const cal = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, unknown>;
      expect(cal.schema).toBe("net-billed.calibration.v1");
      expect(cal.sampleCount).toBe(1);
      expect(cal.totalBaselineFreshInputTokens).toBe(1200);
      expect(cal.totalCompactedFreshInputTokens).toBe(300);
      const allowed = new Set([
        "schema",
        "sampleCount",
        "totalBaselineFreshInputTokens",
        "totalCompactedFreshInputTokens",
        "proofRunIds",
        "updatedAt"
      ]);
      for (const k of Object.keys(cal)) expect(allowed.has(k), k).toBe(true);
      // No key / no content in the store.
      const rawStore = readFileSync(storePath, "utf8");
      expect(rawStore).not.toContain(FAKE_KEY);
      expect(rawStore.toLowerCase()).not.toContain("system");
    } finally {
      await upstream.close();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 30000);

  it("with NO provider key in the env → makes NO call, prints the exact key-gate, exits non-zero, writes NO record", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gw-verify-cache-keygate-"));
    try {
      const res = await runCli(
        ["gateway", "verify-cache", "--provider", "openai", "--upstream", "https://api.openai.com/v1"],
        { cwd, env: baseEnv() } // no OPENAI_API_KEY / OPENAI_KEY
      );
      // Distinct key-gated exit code (non-zero, not a generic failure).
      expect(res.code).toBe(3);
      // The exact key-gate: the env var, the exact command, and which flag flips.
      expect(res.stdout).toContain("key-gated");
      expect(res.stdout).toContain("Required env var:  OPENAI_API_KEY");
      expect(res.stdout).toContain("compaction gateway verify-cache --provider openai");
      expect(res.stdout).toContain("flips liveVerified:true for provider 'openai'");
      // NO provider call, NO record, NO receipts were written.
      expect(existsSync(join(cwd, ".compaction", "gateway", "verifications.jsonl"))).toBe(false);
      expect(existsSync(join(cwd, ".compaction", "gateway", "receipts.jsonl"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 30000);

  it("with a provider that reports NO cache (warm cached=0) → does NOT mark verified; honest reason; no fabricated zero", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gw-verify-cache-nocache-"));
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(upstreamBody(undefined, 0)); // cached=0 on BOTH variants
    });
    try {
      const res = await runCli(
        ["gateway", "verify-cache", "--provider", "openai", "--upstream", `http://127.0.0.1:${upstream.port}`, "--json"],
        { cwd, env: { ...baseEnv(), OPENAI_API_KEY: FAKE_KEY } }
      );
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.stdout) as { verified: boolean; reason?: string; freshInputReductionPercent?: number };
      expect(parsed.verified).toBe(false);
      expect(parsed.reason).toMatch(/live verification not confirmed/i);
      expect(parsed.freshInputReductionPercent).toBeUndefined(); // no fabricated 0

      const records = readVerifications(cwd);
      expect(records).toHaveLength(1);
      expect(records[0].verified).toBe(false);
      expect(records[0].fresh_input_reduction_percent).toBeUndefined(); // never a fabricated zero
      expect(records[0].reason).toBeTruthy();

      // A non-passing record NEVER flips the capability matrix.
      const caps = await runCli(["gateway", "capabilities", "--json"], { cwd, env: baseEnv() });
      const matrix = JSON.parse(caps.stdout) as Array<{ providerId?: string; liveVerified: boolean }>;
      expect(matrix.find((r) => r.providerId === "openai")!.liveVerified).toBe(false);
    } finally {
      await upstream.close();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 30000);
});
