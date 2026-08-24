import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let dir: string;
let runsDir: string;
let outDir: string;

async function run(args: string[], opts: { input?: string } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const child = execFileAsync("./node_modules/.bin/tsx", ["src/cli/index.ts", ...args], {
      cwd: process.cwd()
    });
    if (opts.input !== undefined && child.child.stdin) {
      child.child.stdin.write(opts.input);
      child.child.stdin.end();
    }
    const res = await child;
    return { stdout: res.stdout, stderr: res.stderr, exitCode: 0 };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code ?? 1 };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// A report.json with INPUT-token deltas only (matches the real report shape).
function reportFixture(): string {
  return JSON.stringify({
    run_id: "run_feedback_fixture",
    trace_title: "Feedback fixture run",
    model: "claude-sonnet-4-6",
    original_input_tokens: 10000,
    compacted_input_tokens: 7000,
    tokens_saved: 3000,
    percent_reduction: 30,
    cost_before_per_run: 0.05,
    cost_after_per_run: 0.035,
    saving_per_run: 0.015,
    policy_name: "conservative-v0",
    waste_pattern: null,
    source_message_id: null,
    repeated_count: 0,
    compacted_message_ids: [],
    artifact_version: "compaction-report-v1",
    created_at: "2026-06-15T00:00:00.000Z",
    generated_at: "2026-06-15T00:00:00.000Z",
    approval_readiness_status: "ready",
    approval_readiness_reason: "fixture"
  });
}

const FORBIDDEN_DIAGNOSTIC = [
  "sk-ant-FAKEFAKEFAKE0123456789abcdefABCDEF0123",
  "DATABASE_PASSWORD=hunter2supersecretvalue",
  "You are a helpful assistant with the confidential business plan",
  "TOOL_RESULT: root:x:0:0 customer SSN 123-45-6789",
  "function chargeCustomer(card){ return stripe.charge(card.number); }",
  "contact jane@acme.example at /Users/jane.doe/customers.csv"
].join("\n");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "feedback-cli-"));
  runsDir = join(dir, "runs");
  outDir = join(dir, "bundle");
  await mkdir(join(runsDir, "run_001"), { recursive: true });
  await writeFile(join(runsDir, "run_001", "report.json"), reportFixture(), "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("feedback CLI - preview then explicit confirm (fail-closed)", () => {
  it("previews EXACTLY what will be written and, without confirmation, writes NOTHING", async () => {
    const res = await run([
      "feedback",
      "--redact",
      "--runs",
      runsDir,
      "--out",
      outDir,
      "--command-path",
      "compact"
    ]);
    expect(res.exitCode).toBe(0);
    // Preview present, naming the fields and the excluded categories.
    expect(res.stdout).toContain("Feedback bundle preview");
    expect(res.stdout).toContain("EXCLUDED BY DEFAULT");
    expect(res.stdout.toLowerCase()).toContain("raw trace messages");
    expect(res.stdout).toContain("original_input_tokens:   10000");
    expect(res.stdout).toContain("compacted_input_tokens:  7000");
    // Fail-closed: non-TTY + no --yes → nothing written.
    expect(res.stdout.toLowerCase()).toContain("preview only");
    expect(await exists(join(outDir, "feedback-bundle.json"))).toBe(false);
    expect(await exists(join(outDir, "README.md"))).toBe(false);
  });

  it("writes the bundle + README only with explicit --yes", async () => {
    const res = await run([
      "feedback",
      "--redact",
      "--runs",
      runsDir,
      "--out",
      outDir,
      "--command-path",
      "compact",
      "--evidence-level",
      "measured_input_token_reduction",
      "--yes"
    ]);
    expect(res.exitCode).toBe(0);
    expect(await exists(join(outDir, "feedback-bundle.json"))).toBe(true);
    expect(await exists(join(outDir, "README.md"))).toBe(true);

    const bundle = JSON.parse(await readFile(join(outDir, "feedback-bundle.json"), "utf8")) as Record<string, unknown>;
    expect(bundle.command_path).toBe("compact");
    expect(bundle.evidence_level).toBe("measured_input_token_reduction");
    const tokens = bundle.tokens as Record<string, number>;
    expect(tokens.aggregate_original_input_tokens).toBe(10000);
    expect(tokens.aggregate_compacted_input_tokens).toBe(7000);

    const readme = await readFile(join(outDir, "README.md"), "utf8");
    expect(readme.toLowerCase()).toContain("best-effort");
    expect(readme.toLowerCase()).toContain("you choose whether to send");
    // No upload confirmation in stdout.
    expect(res.stdout.toLowerCase()).toContain("not uploaded");
  });

  it("--confirm is accepted as the explicit gesture alias", async () => {
    const res = await run(["feedback", "--runs", runsDir, "--out", outDir, "--confirm"]);
    expect(res.exitCode).toBe(0);
    expect(await exists(join(outDir, "feedback-bundle.json"))).toBe(true);
  });
});

describe("feedback CLI - forbidden content absent from written bundle", () => {
  it("redacts a diagnostics file containing every forbidden category", async () => {
    const diagPath = join(dir, "diag.log");
    await writeFile(diagPath, FORBIDDEN_DIAGNOSTIC, "utf8");

    const res = await run([
      "feedback",
      "--runs",
      runsDir,
      "--out",
      outDir,
      "--diagnostics-file",
      diagPath,
      "--yes"
    ]);
    expect(res.exitCode).toBe(0);

    const raw = await readFile(join(outDir, "feedback-bundle.json"), "utf8");
    const readme = await readFile(join(outDir, "README.md"), "utf8");
    const everywhere = `${raw}\n${readme}\n${res.stdout}`;

    for (const fragment of [
      "sk-ant-FAKEFAKEFAKE0123456789abcdefABCDEF0123",
      "hunter2supersecretvalue",
      "confidential business plan",
      "root:x:0:0",
      "123-45-6789",
      "stripe.charge",
      "customers.csv",
      "jane@acme.example",
      "jane.doe"
    ]) {
      expect(everywhere, `forbidden fragment leaked: ${fragment}`).not.toContain(fragment);
    }
    // The diagnostics field exists but is redacted.
    const bundle = JSON.parse(raw) as { redacted_diagnostics: string };
    expect(bundle.redacted_diagnostics).toContain("***REDACTED");
  });
});

describe("feedback CLI - no network, no overclaim", () => {
  it("the command source performs no network/upload and the bundle carries no banned claim", async () => {
    // Source-level assertion: the command + core must not import network modules or fetch.
    const cmdSrc = await readFile("src/cli/commands/feedback.ts", "utf8");
    const coreSrc = await readFile("src/core/feedback-bundle.ts", "utf8");
    const combined = `${cmdSrc}\n${coreSrc}`;
    expect(combined).not.toMatch(/\bfetch\s*\(/);
    expect(combined).not.toMatch(/node:https?\b/);
    expect(combined).not.toMatch(/\brequire\(['"]https?['"]\)/);
    expect(combined).not.toMatch(/import[^;]*from\s+['"]node:(?:http|https|net|dgram|tls)['"]/);
    expect(combined).not.toMatch(/\baxios\b|\bgot\b|\bnode-fetch\b|\bundici\b/);

    // Behavioral assertion: written bundle is free of banned first-value claim strings.
    const res = await run(["feedback", "--runs", runsDir, "--out", outDir, "--yes"]);
    expect(res.exitCode).toBe(0);
    const raw = (await readFile(join(outDir, "feedback-bundle.json"), "utf8")).toLowerCase();
    const readme = (await readFile(join(outDir, "README.md"), "utf8")).toLowerCase();
    const stdout = res.stdout.toLowerCase();
    const surface = `${raw}\n${readme}\n${stdout}`;

    expect(surface).not.toContain("per month");
    expect(surface).not.toContain("monthly savings");
    expect(surface).not.toContain("guaranteed savings");
    expect(surface).not.toContain("billing-confirmed savings");
    expect(surface).not.toMatch(/output[\s-]token[\s-]reduction(?!\s+claim)/);
    // Honest signals ARE present.
    expect(surface).toContain("estimated");
    expect(surface).toContain("best-effort");
    expect(surface).toContain("workflow_confirmed is not billing_confirmed");
  });
});

describe("feedback CLI - usage_metadata allowlist (P1 privacy)", () => {
  it("writes ONLY allowlisted usage fields; forbidden keys/values absent from the bundle", async () => {
    const usagePath = join(dir, "usage.json");
    await writeFile(
      usagePath,
      JSON.stringify({
        input_tokens: 8000,
        output_tokens: 400,
        total_tokens: 8400,
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        // forbidden - provider exports can carry these alongside token counts
        email: "leak-contact@customer.example",
        user_id: "user_PRIVATE_42",
        prompt: "Confidential: the unreleased product roadmap for next quarter",
        request_body: "{\"messages\":[{\"role\":\"user\",\"content\":\"secret payload\"}]}"
      }),
      "utf8"
    );

    const res = await run([
      "feedback",
      "--runs",
      runsDir,
      "--out",
      outDir,
      "--usage-metadata",
      usagePath,
      "--yes"
    ]);
    expect(res.exitCode).toBe(0);

    const raw = await readFile(join(outDir, "feedback-bundle.json"), "utf8");
    const readme = await readFile(join(outDir, "README.md"), "utf8");
    const everywhere = `${raw}\n${readme}\n${res.stdout}`;

    // Allowlisted fields survived.
    const bundle = JSON.parse(raw) as {
      usage_metadata: Record<string, unknown>;
      usage_metadata_dropped_key_count: number;
    };
    expect(bundle.usage_metadata).toEqual({
      input_tokens: 8000,
      output_tokens: 400,
      total_tokens: 8400,
      model: "claude-sonnet-4-6",
      provider: "anthropic"
    });
    expect(bundle.usage_metadata_dropped_key_count).toBe(4);

    // Forbidden keys and values are absent from EVERY written/printed surface.
    for (const fragment of [
      "leak-contact@customer.example",
      "user_PRIVATE_42",
      "unreleased product roadmap",
      "secret payload",
      '"email"',
      '"user_id"',
      '"prompt"',
      '"request_body"'
    ]) {
      expect(everywhere, `forbidden usage fragment leaked: ${fragment}`).not.toContain(fragment);
    }
  });
});

describe("feedback CLI - evidence-level reject billing_confirmed + cap to evidence (P2)", () => {
  it("REJECTS --evidence-level billing_confirmed and writes nothing", async () => {
    const res = await run([
      "feedback",
      "--runs",
      runsDir,
      "--out",
      outDir,
      "--evidence-level",
      "billing_confirmed",
      "--yes"
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(`${res.stderr}${res.stdout}`).toContain("billing_confirmed");
    // Fail-closed: nothing written.
    expect(await exists(join(outDir, "feedback-bundle.json"))).toBe(false);
  });

  it("caps usage_confirmed to workflow_confirmed when NO usage metadata is supplied", async () => {
    const res = await run([
      "feedback",
      "--runs",
      runsDir,
      "--out",
      outDir,
      "--evidence-level",
      "usage_confirmed",
      "--yes"
    ]);
    expect(res.exitCode).toBe(0);
    const bundle = JSON.parse(await readFile(join(outDir, "feedback-bundle.json"), "utf8")) as {
      evidence_level: string;
    };
    // Without usage metadata the label is capped below usage_confirmed.
    expect(bundle.evidence_level).toBe("workflow_confirmed");
    expect(res.stdout.toLowerCase()).toContain("capped");
  });

  it("ALLOWS usage_confirmed when allowlisted usage metadata IS supplied", async () => {
    const usagePath = join(dir, "usage-ok.json");
    await writeFile(usagePath, JSON.stringify({ input_tokens: 8000, output_tokens: 400 }), "utf8");
    const res = await run([
      "feedback",
      "--runs",
      runsDir,
      "--out",
      outDir,
      "--evidence-level",
      "usage_confirmed",
      "--usage-metadata",
      usagePath,
      "--yes"
    ]);
    expect(res.exitCode).toBe(0);
    const bundle = JSON.parse(await readFile(join(outDir, "feedback-bundle.json"), "utf8")) as {
      evidence_level: string;
    };
    expect(bundle.evidence_level).toBe("usage_confirmed");
  });

  it("caps usage_confirmed to workflow_confirmed when usage metadata has NO numeric token counts (model/provider only)", async () => {
    const usagePath = join(dir, "usage-no-numbers.json");
    await writeFile(usagePath, JSON.stringify({ model: "claude", provider: "anthropic" }), "utf8");
    const res = await run([
      "feedback",
      "--runs",
      runsDir,
      "--out",
      outDir,
      "--evidence-level",
      "usage_confirmed",
      "--usage-metadata",
      usagePath,
      "--yes"
    ]);
    expect(res.exitCode).toBe(0);
    const bundle = JSON.parse(await readFile(join(outDir, "feedback-bundle.json"), "utf8")) as {
      evidence_level: string;
    };
    // model/provider strings alone do not substantiate usage_confirmed → capped.
    expect(bundle.evidence_level).toBe("workflow_confirmed");
    expect(res.stdout.toLowerCase()).toContain("capped");
  });
});
