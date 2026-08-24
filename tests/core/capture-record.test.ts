import { describe, expect, it } from "vitest";
import { buildCaptureRecordRequest, captureTokenSource } from "../../src/core/capture-record.js";
import { createUsageMetadata } from "../../src/core/usage-metadata.js";

/**
 * Shared content-free record step. Asserts the three honesty axes
 * stay distinct: provider-reported vs local-estimate source; input/output counted SEPARATELY; and the
 * body is metrics_only (no content, no savings figure).
 */
describe("capture-record - honest content-free record request", () => {
  it("provider-reported usage → provider-reported source + separate input/output + attribution", () => {
    const usage = createUsageMetadata({
      inputTokens: 1000,
      outputTokens: 200,
      providerReportedTokens: true,
      estimatedTokens: false,
      model: "gpt-5",
      provider: "openai"
    });
    expect(captureTokenSource(usage)).toBe("provider-reported");

    const req = buildCaptureRecordRequest({ usage, tool: "codex", reference: "local://captured-trace.json" });
    expect(req.payload_class).toBe("metrics_only");
    expect((req.trace as { content?: unknown }).content).toBeUndefined(); // content-free
    expect(req.token_usage.source).toBe("provider-reported");
    expect(req.token_usage.input_tokens).toBe(1000);
    expect(req.token_usage.output_tokens).toBe(200); // input and output SEPARATE
    expect(req.provider_metadata).toMatchObject({ tool: "codex", provider: "openai", model: "gpt-5" });
    // No savings figure anywhere in the body, only token counts + source.
    expect(JSON.stringify(req)).not.toMatch(/saving/i);
  });

  it("local-estimate usage → local-estimate source (honest); input AND output carried separately", () => {
    const usage = createUsageMetadata({ inputTokens: 50, outputTokens: 12, providerReportedTokens: false, estimatedTokens: true, model: "claude-haiku-4-5" });
    expect(captureTokenSource(usage)).toBe("local-estimate");
    const req = buildCaptureRecordRequest({ usage, tool: "cursor", reference: "local://t" });
    expect(req.token_usage.source).toBe("local-estimate");
    expect(req.token_usage.input_tokens).toBe(50);
    expect(req.token_usage.output_tokens).toBe(12); // local-estimate output also recorded separately
    expect(req.provider_metadata?.tool).toBe("cursor");
  });

  it("missing usage → unknown source, no fabricated counts", () => {
    const usage = createUsageMetadata({ providerReportedTokens: false, estimatedTokens: false });
    expect(captureTokenSource(usage)).toBe("unknown");
    const req = buildCaptureRecordRequest({ usage, tool: "other", reference: "local://t" });
    expect(req.token_usage.source).toBe("unknown");
    expect(req.token_usage.input_tokens).toBeUndefined();
    expect(req.token_usage.output_tokens).toBeUndefined();
  });
});
