import { afterEach, describe, it, expect } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * `compaction gateway start` CLI. Ships RECORD mode, apply/cache are
 * rejected honestly (not-implemented), arg validation fails closed, and record mode starts + prints the
 * honest banner. No real provider keys or network: record-start is killed immediately after it binds.
 */
const CLI = resolve("dist/cli/index.js");

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 0 };
}

describe("gateway start - mode gating + validation (record | apply | dry-run)", () => {
  it("--mode apply WITHOUT --policy fails closed (apply requires an explicit deterministic policy)", () => {
    const r = run(["gateway", "start", "--mode", "apply"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/requires --policy deterministic-dedupe/i);
    expect(r.stderr).toMatch(/deterministic-only/i);
  });

  it("--mode apply --policy <unknown> fails closed (only deterministic-dedupe is implemented)", () => {
    const r = run(["gateway", "start", "--mode", "apply", "--policy", "magic-summarizer"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/requires --policy deterministic-dedupe/i);
  });

  it("--mode cache is rejected honestly (not implemented - record | apply | dry-run)", () => {
    const r = run(["gateway", "start", "--mode", "cache"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not implemented/i);
  });

  it("gateway recover with an unknown id fails closed (nothing to recover)", () => {
    const r = run(["gateway", "recover", "no-such-id"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no retained original found/i);
  });

  it("invalid --upstream fails closed", () => {
    const r = run(["gateway", "start", "--upstream", "not a url", "--mode", "record"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not a valid URL/i);
  });

  it("invalid --listen port fails closed", () => {
    const r = run(["gateway", "start", "--listen", "http://127.0.0.1:0", "--mode", "record"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/invalid --listen port/i);
  });

  it("help documents the gateway as byte-safe record-mode (no mutation)", () => {
    const r = run(["gateway", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("byte-safe");
    expect(r.stdout.toLowerCase()).toContain("record");
  });

  it("gateway help exposes the gateway-native `run` command and NO `doctor`", () => {
    const r = run(["gateway", "--help"]);
    expect(r.code).toBe(0);
    // product surface: run/status/configure/recover present; doctor removed.
    expect(r.stdout).toMatch(/\brun\b/);
    expect(r.stdout).toContain("status");
    expect(r.stdout).toContain("recover");
    expect(r.stdout).not.toContain("doctor");
  });

  it("gateway run with no command → honest usage error mentioning `gateway run`", () => {
    const r = run(["gateway", "run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no command given/i);
    expect(r.stderr).toMatch(/compaction gateway run -- <command>/);
  });

  it("gateway activate prints eval-able export lines (stdout) and never mutates files/shell", () => {
    const r = run(["gateway", "activate"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/export OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:\d+\/v1/);
    expect(r.stdout).toMatch(/export OPENAI_API_BASE=http:\/\/127\.0\.0\.1:\d+\/v1/);
    // guidance rides on stderr so `eval "$(…)"` only captures the exports.
    expect(r.stderr).toMatch(/eval "\$\(compaction gateway activate\)"/);
  });

  it("gateway activate --provider anthropic prints ANTHROPIC_BASE_URL (NO /v1), not OPENAI_BASE_URL", () => {
    const r = run(["gateway", "activate", "--provider", "anthropic"]);
    expect(r.code).toBe(0);
    // Anthropic base URL has NO /v1 suffix, Claude Code appends /v1/messages itself.
    expect(r.stdout).toMatch(/export ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+$/m);
    expect(r.stdout).not.toContain("/v1");
    expect(r.stdout).not.toMatch(/OPENAI_BASE_URL/);
    // still only prints (key stays in the shell; gateway never reads it).
    expect(r.stderr).toMatch(/never reads or stores it/i);
  });

  it("record mode starts, prints the honest banner, and never claims to store the key", async () => {
    const port = 8791; // a fixed high port for this focused start-then-kill check
    const child = spawn("node", [CLI, "gateway", "start", "--mode", "record", "--provider", "openai", "--upstream", "https://api.openai.com/v1", "--listen", `http://127.0.0.1:${port}`], { encoding: "utf8" });
    let out = "";
    const banner = await new Promise<string>((resolveBanner) => {
      child.stdout.on("data", (d) => {
        out += d.toString();
        // Wait for the LAST banner line ("press Ctrl-C") so the whole banner is captured before we assert
        // on trailing lines (the "Gateway running at" marker appears earlier and would truncate the capture).
        if (out.includes("Ctrl-C")) resolveBanner(out);
      });
      child.on("exit", () => resolveBanner(out));
      // Generous fallback: node CLI startup can be slow under full-suite parallel load.
      setTimeout(() => resolveBanner(out), 20000);
    });
    child.kill("SIGKILL");

    expect(banner).toMatch(/RECORD mode/);
    expect(banner).toMatch(/byte-safe/i);
    expect(banner).toMatch(/Gateway running at http:\/\/127\.0\.0\.1:8791/);
    expect(banner).toMatch(/baseURL = http:\/\/127\.0\.0\.1:8791\/v1/);
    expect(banner).toMatch(/never stores it/i); // honest: the gateway never stores the provider key
    expect(banner).toMatch(/no prompt\/response content/i); // content-free receipts
  }, 30000); // explicit per-test timeout (> the internal fallback) so a slow-load start is not killed at 5s
});

describe("gateway status / stop lifecycle", () => {
  let cwd = "";
  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    cwd = ""; // reset so the next test gets a fresh tmp dir (not a deleted path)
  });
  const runIn = (args: string[]): { stdout: string; code: number } => {
    if (!cwd) cwd = mkdtempSync(join(tmpdir(), "gw-cli-"));
    const r = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
    return { stdout: r.stdout ?? "", code: r.status ?? 0 };
  };

  it("status with no gateway and no receipts → not running, 0 receipts", () => {
    const r = runIn(["gateway", "status"]);
    expect(r.code).toBe(0);
    // The row names the lifecycle it reads: the PROJECT/dev pidfile in this cwd. The
    // transparent-routing endpoint has its own lifecycle and its own block.
    expect(r.stdout).toMatch(/project\/dev gateway:\s*not running/i);
    expect(r.stdout).toMatch(/requests observed:\s*0/i);
    expect(r.stdout).toMatch(/last request:\s*none observed yet/i);
  });

  it("status with local receipts → count + provider-backed fresh/billed reduction (content-free)", () => {
    cwd = mkdtempSync(join(tmpdir(), "gw-cli-"));
    const gw = join(cwd, ".compaction", "gateway");
    mkdirSync(gw, { recursive: true });
    writeFileSync(
      join(gw, "receipts.jsonl"),
      [
        JSON.stringify({ tokens: { prompt_input: 100, cached_input: 40, billed_fresh_input: 60, output: 20 }, token_source: "provider-reported", model_visible_bytes_changed: false }),
        JSON.stringify({ tokens: { prompt_input: 100, output: 10 }, token_source: "provider-reported", model_visible_bytes_changed: false })
      ].join("\n") + "\n",
      "utf8"
    );
    const r = runIn(["gateway", "status"]);
    expect(r.stdout).toMatch(/requests observed:\s*2/i);
    expect(r.stdout).toMatch(/cached input seen:\s*yes/i);
    expect(r.stdout).toContain("-40% fresh/billed input");
    expect(r.stdout).toContain("model-visible bytes unchanged");
    expect(r.stdout).not.toMatch(/cost saved|reduced output|reduced model-visible/i);
  });

  it("stop with no pidfile → nothing to stop", () => {
    const r = runIn(["gateway", "stop"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no gateway pidfile/i);
  });

  it("stop with a stale pidfile (dead pid) → clears it", () => {
    cwd = mkdtempSync(join(tmpdir(), "gw-cli-"));
    const gw = join(cwd, ".compaction", "gateway");
    mkdirSync(gw, { recursive: true });
    writeFileSync(join(gw, "gateway.json"), JSON.stringify({ pid: 2147483646, host: "127.0.0.1", port: 65000, upstream: "u", provider: "openai", mode: "record", startedAt: "t" }), "utf8");
    const r = runIn(["gateway", "stop"]);
    expect(r.stdout).toMatch(/stale pidfile/i);
  });
});

describe("gateway proof CLI", () => {
  let cwd = "";
  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    cwd = "";
  });
  const runProof = (lines: unknown[]): { stdout: string; code: number } => {
    cwd = mkdtempSync(join(tmpdir(), "gw-proof-cli-"));
    const gw = join(cwd, ".compaction", "gateway");
    mkdirSync(gw, { recursive: true });
    writeFileSync(join(gw, "receipts.jsonl"), lines.length === 0 ? readFileSync(resolve("tests/fixtures/gateway-proof/demo-001-receipts.jsonl"), "utf8") : lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    const r = spawnSync("node", [CLI, "gateway", "proof", "--proof-run", "demo-001"], { cwd, encoding: "utf8" });
    return { stdout: r.stdout ?? "", code: r.status ?? 0 };
  };

  it("prints the before/after proof moment from local content-free receipts", () => {
    const r = runProof([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("baseline receipt found: yes");
    expect(r.stdout).toContain("compacted receipt found: yes");
    // demo-001 is the reduced-input scenario (total 1,000 -> 700): rows are labeled
    // baseline/compacted and the model-visible change is disclosed.
    expect(r.stdout).toContain("baseline fresh input tokens: 1,000");
    expect(r.stdout).toContain("compacted fresh input tokens: 630");
    expect(r.stdout).toContain("provider-reported fresh input reduced by 37%");
    expect(r.stdout).not.toContain("Same context");
    expect(r.stdout).toContain("Model-visible input changed: yes (fewer input tokens sent)");
    expect(r.stdout).toContain("Approval required: yes (model-visible context change)");
    // No positive cost/leak claims. "billing-confirmed"/"invoice" may appear ONLY inside the
    // honest NEGATIVE disclaimer ("not billing-confirmed invoice savings") - strip it first.
    expect(r.stdout).not.toMatch(/cost reduced|prompt|completion|message|content/i);
    const stripped = r.stdout.replace(/\bnot\s+billing-confirmed\s+invoice\s+savings\b/gi, "");
    expect(stripped).not.toMatch(/billing-confirmed|invoice/i);
  });

  it("prints unavailable when provider usage/cached tokens are missing", () => {
    const r = runProof([
      { proof_run_id: "demo-001", proof_variant: "baseline", tokens: { prompt_input: 1000 }, token_source: "provider-reported", cache_source: "unavailable" }
    ]);
    expect(r.stdout).toContain("baseline receipt found: yes");
    expect(r.stdout).toContain("compacted receipt found: no");
    expect(r.stdout).toContain("reduction unavailable");
    expect(r.stdout).toMatch(/cached_tokens|not found/);
  });
});
