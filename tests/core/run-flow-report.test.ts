import { describe, expect, it } from "vitest";
import { buildRunFlowTokenReport, formatRunFlowTokenReport } from "../../src/core/run-flow-report.js";
import { createUsageMetadata, missingUsageMetadata } from "../../src/core/usage-metadata.js";

/**
 * Shared HONEST run-flow report. These tests are the
 * binding backstop for the three honesty boundaries of the unified `run <tool>` front-ends:
 *   1. `token_source` is surfaced explicitly as provider-reported | local-estimate | unavailable;
 *   2. input and output tokens are reported SEPARATELY;
 *   3. output is shown as TOKENS and is NEVER labeled a saving.
 */
describe("run-flow-report - honest per-field token_source", () => {
  it("codex (provider-reported): input+output token_source = provider-reported, shown SEPARATELY", () => {
    const usage = createUsageMetadata({
      inputTokens: 1200,
      outputTokens: 300,
      providerReportedTokens: true,
      estimatedTokens: false,
      model: "gpt-5-codex",
      provider: "openai"
    });
    const report = buildRunFlowTokenReport({ tool: "codex", usage, outputStatus: "present" });

    expect(report.input_token_source).toBe("provider-reported");
    expect(report.output_token_source).toBe("provider-reported");
    expect(report.input_tokens).toBe(1200);
    expect(report.output_tokens).toBe(300); // input and output carried SEPARATELY
    expect(report.input_reduction_label).toBe("measured"); // provider-reported → measured reduction

    const text = formatRunFlowTokenReport(report).join("\n");
    expect(text).toMatch(/input tokens: 1200 \(source: provider-reported\)/);
    expect(text).toMatch(/output tokens: 300 \(source: provider-reported\)/);
  });

  it("claude-code (provider-reported): joins the SAME honest report - input+output provider-reported, shown SEPARATELY", () => {
    // Unified-flow D1/D3: Claude Code joins the shared report via its existing capture. Session usage is
    // provider-reported and whole (like Codex, no per-field unavailable split), so outputStatus="present".
    const usage = createUsageMetadata({
      inputTokens: 5400,
      outputTokens: 820,
      providerReportedTokens: true,
      estimatedTokens: false,
      model: "claude-sonnet-4",
      provider: "anthropic"
    });
    const report = buildRunFlowTokenReport({ tool: "claude-code", usage, outputStatus: "present" });

    expect(report.tool).toBe("claude-code");
    expect(report.input_token_source).toBe("provider-reported");
    expect(report.output_token_source).toBe("provider-reported");
    expect(report.input_tokens).toBe(5400);
    expect(report.output_tokens).toBe(820); // input and output carried SEPARATELY
    expect(report.input_reduction_label).toBe("measured"); // provider-reported → measured reduction

    const text = formatRunFlowTokenReport(report).join("\n");
    expect(text).toMatch(/Token reality for claude-code \(honest per-field source\)/);
    expect(text).toMatch(/input tokens: 5400 \(source: provider-reported\)/);
    expect(text).toMatch(/output tokens: 820 \(source: provider-reported\)/);
    // Output is shown as tokens only, never a saving (the binding output rail applies to Claude Code too).
    expect(text).toMatch(/output is shown as TOKENS ONLY/);
    expect(text).toMatch(/output-token savings are not claimed/);
  });

  it("input axis is the MODEL-VISIBLE input (fresh + cache read + cache creation) - same cumulative basis as output", () => {
    // The provider's raw `input_tokens` field is only the UNCACHED remainder of each request's
    // context. Reporting it alone against full output is a mixed basis (output can misleadingly
    // dwarf input for context-heavy sessions). The report's input axis folds in provider-reported
    // cached input so input and output share one basis.
    const usage = createUsageMetadata({
      inputTokens: 2_400, // fresh (uncached) input summed over the session's requests
      outputTokens: 15_000,
      cacheReadInputTokens: 2_397_600,
      cacheCreationInputTokens: 33_000,
      providerReportedTokens: true,
      estimatedTokens: false,
      model: "claude-sonnet-4-6",
      provider: "anthropic"
    });
    const report = buildRunFlowTokenReport({ tool: "claude-code", usage, outputStatus: "present" });

    expect(report.input_tokens).toBe(2_433_000); // 2,400 + 2,397,600 + 33,000
    expect(report.output_tokens).toBe(15_000);
    expect(report.input_token_source).toBe("provider-reported");
    // Same-basis guard: a context-heavy session must not show output larger than input.
    expect(report.output_tokens!).toBeLessThanOrEqual(report.input_tokens!);
    // The basis is stated honestly (model-visible input, not fresh/billed input alone).
    expect(report.notes.join("\n")).toContain("model-visible input");

    // No cache fields reported → the input axis is unchanged (nothing invented) and no basis note added.
    const noCache = createUsageMetadata({
      inputTokens: 1200,
      outputTokens: 300,
      providerReportedTokens: true,
      estimatedTokens: false,
      model: "claude-sonnet-4-6",
      provider: "anthropic"
    });
    const plain = buildRunFlowTokenReport({ tool: "claude-code", usage: noCache, outputStatus: "present" });
    expect(plain.input_tokens).toBe(1200);
    expect(plain.notes.join("\n")).not.toContain("model-visible input");
  });

  it("claude-code (no provider usage): honestly downgrades to local-estimate/unavailable, never overclaims", () => {
    // A session that lacks provider usage must NOT be labeled provider-reported just because the tool is
    // Claude Code, the shared builder labels only what the evidence supports.
    const usage = createUsageMetadata({
      inputTokens: 300,
      providerReportedTokens: false,
      estimatedTokens: true,
      provider: "anthropic"
    });
    const report = buildRunFlowTokenReport({ tool: "claude-code", usage, outputStatus: "unavailable" });
    expect(report.input_token_source).toBe("local-estimate");
    expect(report.output_token_source).toBe("unavailable");
    expect(report.input_reduction_label).toBe("estimated");
  });

  it("cursor (local-estimate, output present): both fields local-estimate; reduction = estimated", () => {
    const usage = createUsageMetadata({
      inputTokens: 40,
      outputTokens: 18,
      providerReportedTokens: false,
      estimatedTokens: true,
      provider: "cursor"
    });
    const report = buildRunFlowTokenReport({ tool: "cursor", usage, outputStatus: "present" });

    expect(report.input_token_source).toBe("local-estimate");
    expect(report.output_token_source).toBe("local-estimate");
    expect(report.input_tokens).toBe(40);
    expect(report.output_tokens).toBe(18);
    expect(report.input_reduction_label).toBe("estimated");
  });

  it("cursor (output unavailable): output_token_source = unavailable, never local-estimate, never zero", () => {
    // Input estimated from the prompt; output field could not be safely separated → unavailable.
    const usage = createUsageMetadata({
      inputTokens: 40,
      providerReportedTokens: false,
      estimatedTokens: true,
      provider: "cursor"
    });
    const report = buildRunFlowTokenReport({ tool: "cursor", usage, outputStatus: "unavailable" });

    expect(report.input_token_source).toBe("local-estimate");
    expect(report.output_token_source).toBe("unavailable"); // forced unavailable
    expect(report.output_tokens).toBeUndefined(); // never silently zero
    const text = formatRunFlowTokenReport(report).join("\n");
    expect(text).toMatch(/output tokens: unavailable/);
    expect(text).not.toMatch(/output tokens: 0/);
  });

  it("missing usage: both fields unavailable, no fabricated counts", () => {
    const usage = missingUsageMetadata({ provider: "cursor" });
    const report = buildRunFlowTokenReport({ tool: "cursor", usage, outputStatus: "unavailable" });
    expect(report.input_token_source).toBe("unavailable");
    expect(report.output_token_source).toBe("unavailable");
    expect(report.input_tokens).toBeUndefined();
    expect(report.output_tokens).toBeUndefined();
  });

  it("NEVER labels output a saving (the binding output rail) for any tool", () => {
    const provider = createUsageMetadata({ inputTokens: 100, outputTokens: 50, providerReportedTokens: true, estimatedTokens: false, model: "gpt-5", provider: "openai" });
    const estimate = createUsageMetadata({ inputTokens: 100, outputTokens: 50, providerReportedTokens: false, estimatedTokens: true, provider: "cursor" });

    for (const usage of [provider, estimate]) {
      const text = formatRunFlowTokenReport(buildRunFlowTokenReport({ tool: "codex", usage, outputStatus: "present" })).join("\n");
      // Output is shown as tokens only; there is no POSITIVE output-savings FIGURE. The only savings
      // phrasing allowed is the figure-free negated rail ("output-token savings are not claimed").
      expect(text).not.toMatch(/output[^\n]*\b(saved|savings)\b[^\n]*[\d$%]/i);
      // The explicit rail is present.
      expect(text).toMatch(/output is shown as TOKENS ONLY/);
      expect(text).toMatch(/output-token savings are not claimed/);
    }
  });

  it("only the three sanctioned token_source values ever appear", () => {
    const usage = createUsageMetadata({ inputTokens: 10, outputTokens: 5, providerReportedTokens: false, estimatedTokens: true });
    const report = buildRunFlowTokenReport({ tool: "cursor", usage, outputStatus: "present" });
    const allowed = new Set(["provider-reported", "local-estimate", "unavailable"]);
    expect(allowed.has(report.input_token_source)).toBe(true);
    expect(allowed.has(report.output_token_source)).toBe(true);
  });
});
