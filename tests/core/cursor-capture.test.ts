import { describe, expect, it } from "vitest";
import { normalizeCursorAgentOutput, captureCursorExport, extractCursorPrompt, parseCursorAgentOutput } from "../../src/core/cursor-capture.js";

/**
 * Cursor live-wrapper normalizer. Exercises the
 * DOCUMENTED Cursor headless `--output-format json`/`stream-json` shapes on synthetic fixtures;
 * real-artifact validation against a true Cursor run remains OPEN (operator-side).
 *
 * Defining honesty boundaries asserted here: NO provider-reported tokens; LOCAL-ESTIMATE only; output from
 * the separable `result` field, else UNAVAILABLE; never an output-savings claim.
 */
const JSON_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  duration_ms: 1234,
  is_error: false,
  result: "Fixed the null check in auth.ts and added a regression test.",
  session_id: "sess-abc-123",
  request_id: "req-1"
});

const CMD = ["cursor", "agent", "-p", "fix the auth bug", "--output-format", "json"];

describe("normalizeCursorAgentOutput - LOCAL-ESTIMATE only, output where separable", () => {
  it("estimates input (prompt) + output (result field) locally; NEVER provider-reported", () => {
    const r = normalizeCursorAgentOutput({ captureId: "c1", rawOutput: JSON_RESULT, commandParts: CMD });
    expect(r.usageMetadata.provider_reported_tokens).toBe(false);
    expect(r.usageMetadata.estimated_tokens).toBe(true);
    expect(r.outputStatus).toBe("present");
    expect(r.usageMetadata.input_tokens).toBeGreaterThan(0); // local-estimate from the prompt
    expect(r.usageMetadata.output_tokens).toBeGreaterThan(0); // local-estimate from the result field
    expect(r.usageMetadata.provider).toBe("cursor");
    expect(r.trace.source).toBe("local_command");
    expect(r.trace.id).toBe("sess-abc-123");
    expect(r.usageMetadata.limitations.join(" ")).toContain("LOCAL-ESTIMATE only");
  });

  it("marks output UNAVAILABLE (no fabrication) when no separable result field is present", () => {
    const r = normalizeCursorAgentOutput({ captureId: "c2", rawOutput: "Fixed the bug.", commandParts: CMD });
    expect(r.outputStatus).toBe("unavailable");
    expect(r.usageMetadata.output_tokens).toBeUndefined(); // never silently zero
    expect(r.usageMetadata.provider_reported_tokens).toBe(false);
    // input still estimated from the prompt
    expect(r.usageMetadata.input_tokens).toBeGreaterThan(0);
    expect(r.warnings.join(" ")).toContain("Output tokens UNAVAILABLE");
  });

  it("never reports provider-reported tokens and never an output-savings figure", () => {
    const r = normalizeCursorAgentOutput({ captureId: "c3", rawOutput: JSON_RESULT, commandParts: CMD });
    expect(r.usageMetadata.cost_source).not.toBe("provider_reported");
    expect(JSON.stringify(r)).not.toMatch(/saving/i);
  });

  it("parses a stream-json stream for the result + session id", () => {
    const stream = [
      `{"type":"assistant","timestamp_ms":1,"model_call_id":"m1"}`,
      `{"type":"result","result":"done","session_id":"sess-stream-9"}`
    ].join("\n");
    const parsed = parseCursorAgentOutput(stream);
    expect(parsed.outputSeparable).toBe(true);
    expect(parsed.resultText).toBe("done");
    expect(parsed.sessionId).toBe("sess-stream-9");
  });

  it("extractCursorPrompt keeps the prompt and skips flag values (e.g. --output-format json)", () => {
    expect(extractCursorPrompt(CMD)).toBe("fix the auth bug");
    expect(extractCursorPrompt(["cursor", "agent", "--output-format", "json", "-p", "do X"])).toBe("do X");
    expect(extractCursorPrompt(["cursor", "agent"])).toBeUndefined();
  });

  it("marks input unavailable (absent) when no prompt can be identified - with the export-only TRUE reason", () => {
    const r = normalizeCursorAgentOutput({ captureId: "c4", rawOutput: JSON_RESULT }); // no commandParts → export-only
    expect(r.usageMetadata.input_tokens).toBeUndefined();
    expect(r.inputStatus).toBe("unavailable");
    // Export-only: the reason says the EXPORT does not contain the prompt and no invocation was declared -
    // never the wrong "wrapped invocation" reason (there was no wrapped invocation).
    expect(r.inputUnavailableReason).toContain("a saved Cursor export does not contain the prompt");
    expect(r.inputUnavailableReason).toContain("no invocation was declared after --");
    expect(r.inputUnavailableReason).not.toContain("wrapped invocation");
    const warning = r.warnings.join(" ");
    expect(warning).toContain("Input tokens UNAVAILABLE");
    // Actionable: the warning says exactly how to get a LOCAL-ESTIMATE input count (re-declare after --).
    expect(warning).toContain("re-declare the original invocation after --");
    expect(warning).toContain("LOCAL-ESTIMATE");
    expect(warning).toContain("never provider-reported");
    // The SAME reason rides in the limitations so run records + summary carry it (no surface divergence).
    expect(r.usageMetadata.limitations.join(" ")).toContain("a saved Cursor export does not contain the prompt");
    // output still estimated from the result field; still never provider-reported
    expect(r.usageMetadata.output_tokens).toBeGreaterThan(0);
    expect(r.usageMetadata.provider_reported_tokens).toBe(false);
  });

  it("a DECLARED invocation with no identifiable prompt gets the wrapped-invocation reason (not the export-only one)", () => {
    const r = normalizeCursorAgentOutput({ captureId: "c4b", rawOutput: JSON_RESULT, commandParts: ["cursor", "agent"] });
    expect(r.inputStatus).toBe("unavailable");
    expect(r.inputUnavailableReason).toBe("no prompt could be identified in the wrapped invocation");
    expect(r.warnings.join(" ")).toContain('pass the prompt in the invocation');
    expect(r.usageMetadata.input_tokens).toBeUndefined(); // never fabricated
  });

  it("with an identified prompt, inputStatus is present and NO input-unavailable reason/limitation is emitted", () => {
    const r = normalizeCursorAgentOutput({ captureId: "c4c", rawOutput: JSON_RESULT, commandParts: CMD });
    expect(r.inputStatus).toBe("present");
    expect(r.inputUnavailableReason).toBeUndefined();
    expect(r.usageMetadata.limitations.join(" ")).not.toContain("Input tokens are unavailable");
    expect(r.warnings.join(" ")).not.toContain("Input tokens UNAVAILABLE");
  });

  it("captureCursorExport normalizes saved output the same way", () => {
    const r = captureCursorExport(JSON_RESULT, CMD);
    expect(r.usageMetadata.estimated_tokens).toBe(true);
    expect(r.trace.source).toBe("local_command");
    expect(r.outputStatus).toBe("present");
  });

  it("token_source is local_estimate (never provider_reported) and output tokens = chars/4 of the result", () => {
    const resultText = "x".repeat(200); // 200 chars → 50 tokens at chars/4
    const raw = JSON.stringify({ type: "result", result: resultText, session_id: "s-count" });
    const r = normalizeCursorAgentOutput({ captureId: "count", rawOutput: raw, commandParts: CMD });
    // Local-estimate is chars/4 (token-estimator contract), never provider-reported.
    expect(r.usageMetadata.output_tokens).toBe(50);
    expect(r.usageMetadata.cost_source).toBe("local_estimate");
    expect(r.usageMetadata.cost_source).not.toBe("provider_reported");
    // Provider is attributed as cursor; Compaction did not ingest provider-reported usage.
    expect(r.usageMetadata.provider).toBe("cursor");
    expect(r.usageMetadata.provider_reported_tokens).toBe(false);
  });

  it("the UNAVAILABLE output warning states the parser gap - never a silent zero", () => {
    const r = normalizeCursorAgentOutput({ captureId: "reason", rawOutput: "plain text, no result field", commandParts: CMD });
    expect(r.outputStatus).toBe("unavailable");
    expect(r.usageMetadata.output_tokens).toBeUndefined(); // absent, not 0
    const warning = r.warnings.join(" ");
    expect(warning).toContain("Output tokens UNAVAILABLE");
    expect(warning).toContain("no separable `result` field");
    expect(warning).toMatch(/does not ingest[^.]*conditional result\.usage/i);
    // The limitation carried into the usage metadata records the unavailability too.
    expect(r.usageMetadata.limitations.join(" ")).toContain("Output tokens are unavailable");
  });
});

describe("parseCursorAgentOutput - robustness on malformed / partial / multi-result output", () => {
  it("returns outputSeparable:false (no throw) on empty, whitespace, and non-JSON input", () => {
    for (const raw of ["", "   \n  ", "just some plain text", "not json at all"]) {
      const parsed = parseCursorAgentOutput(raw);
      expect(parsed.outputSeparable).toBe(false);
      expect(parsed.resultText).toBeUndefined();
    }
  });

  it("returns outputSeparable:false (no throw) on malformed / partial JSON", () => {
    // Truncated object, trailing garbage, and an unterminated stream line must all fail gracefully.
    for (const raw of ['{"result": "oops', '{"result":"ok"} trailing junk', '{"type":"result"']) {
      const parsed = parseCursorAgentOutput(raw);
      expect(parsed.outputSeparable).toBe(false);
    }
  });

  it("treats an empty-string or non-string result as NOT separable (no fabricated zero-length output)", () => {
    expect(parseCursorAgentOutput('{"result":""}').outputSeparable).toBe(false);
    expect(parseCursorAgentOutput('{"result":123}').outputSeparable).toBe(false);
    expect(parseCursorAgentOutput('{"result":null}').outputSeparable).toBe(false);
  });

  it("stream-json: LAST result wins; session_id is taken from the first line that carries it", () => {
    const stream = [
      `{"type":"system","session_id":"sess-first"}`,
      `{"type":"result","result":"FIRST"}`,
      `{"type":"result","result":"SECOND"}`
    ].join("\n");
    const parsed = parseCursorAgentOutput(stream);
    expect(parsed.resultText).toBe("SECOND"); // last result wins
    expect(parsed.sessionId).toBe("sess-first"); // first session id seen
    expect(parsed.outputSeparable).toBe(true);
  });

  it("stream-json: a malformed line among valid lines is skipped, not fatal", () => {
    const stream = [
      `{"type":"assistant"`, // malformed (unterminated) → skipped
      `{"type":"result","result":"OK","session_id":"sess-mixed"}`
    ].join("\n");
    const parsed = parseCursorAgentOutput(stream);
    expect(parsed.resultText).toBe("OK");
    expect(parsed.sessionId).toBe("sess-mixed");
    expect(parsed.outputSeparable).toBe(true);
  });
});

describe("normalizeCursorAgentOutput - edge-case hardening (SYNTHETIC fixtures; honest degraded output, never a crash, never a fabricated count)", () => {
  it("SYNTHETIC empty export: output unavailable with the TRUE reason (empty), never the misleading --output-format advice", () => {
    for (const raw of ["", "   \n\t  "]) {
      const r = normalizeCursorAgentOutput({ captureId: "empty", rawOutput: raw, commandParts: CMD });
      expect(r.outputStatus).toBe("unavailable");
      expect(r.usageMetadata.output_tokens).toBeUndefined(); // never fabricated, never zero
      expect(r.outputUnavailableReason).toContain("empty");
      // An empty file cannot be fixed by --output-format json, that advice must NOT be given here.
      expect(r.outputUnavailableReason).not.toContain("--output-format");
      expect(r.warnings.join(" ")).toContain("empty");
      expect(r.usageMetadata.limitations.join(" ")).toContain("empty");
    }
  });

  it("SYNTHETIC non-empty non-separable output: reason names the missing result field (with the --output-format hint)", () => {
    const r = normalizeCursorAgentOutput({ captureId: "nores", rawOutput: "plain text output", commandParts: CMD });
    expect(r.outputStatus).toBe("unavailable");
    expect(r.outputUnavailableReason).toContain("no separable `result` field");
    expect(r.outputUnavailableReason).toContain("--output-format json");
  });

  it("separable output: outputUnavailableReason is absent (reason exists ONLY when output is unavailable)", () => {
    const r = normalizeCursorAgentOutput({ captureId: "ok", rawOutput: JSON_RESULT, commandParts: CMD });
    expect(r.outputStatus).toBe("present");
    expect(r.outputUnavailableReason).toBeUndefined();
  });

  it("SYNTHETIC BOM-prefixed export (e.g. saved on Windows): the real result is parsed, not mislabeled unavailable", () => {
    const r = normalizeCursorAgentOutput({ captureId: "bom", rawOutput: `\uFEFF${JSON_RESULT}`, commandParts: CMD });
    expect(r.outputStatus).toBe("present");
    expect(r.usageMetadata.output_tokens).toBeGreaterThan(0);
    expect(r.trace.id).toBe("sess-abc-123");
    expect(r.usageMetadata.provider_reported_tokens).toBe(false); // still never provider-reported
  });

  it("SYNTHETIC unicode result (emoji/multibyte): counted honestly at chars/4 of the string, no crash", () => {
    const unicodeResult = "修复了认证问题 🎉✅ - größer, café, 日本語テキスト";
    const raw = JSON.stringify({ type: "result", result: unicodeResult, session_id: "s-unicode" });
    const r = normalizeCursorAgentOutput({ captureId: "unicode", rawOutput: raw, commandParts: CMD });
    expect(r.outputStatus).toBe("present");
    // The estimator contract is chars/4 (ceil, min 1) over the JS string - honest local estimate, no fabrication.
    expect(r.usageMetadata.output_tokens).toBe(Math.max(1, Math.ceil(unicodeResult.length / 4)));
    expect(r.usageMetadata.provider_reported_tokens).toBe(false);
  });

  it("SYNTHETIC huge export (~1MB result): no crash; count stays exactly chars/4 (no truncation, no fabrication)", () => {
    const hugeResult = "y".repeat(1_048_576); // 1 MiB of synthetic content
    const raw = JSON.stringify({ type: "result", result: hugeResult, session_id: "s-huge" });
    const r = normalizeCursorAgentOutput({ captureId: "huge", rawOutput: raw, commandParts: CMD });
    expect(r.outputStatus).toBe("present");
    expect(r.usageMetadata.output_tokens).toBe(262_144); // 1_048_576 / 4
    expect(r.usageMetadata.cost_source).toBe("local_estimate");
  });

  it("SYNTHETIC huge NON-JSON garbage (~1MB): degrades honestly (output unavailable), never throws", () => {
    const raw = "not json ".repeat(120_000);
    const r = normalizeCursorAgentOutput({ captureId: "huge-garbage", rawOutput: raw, commandParts: CMD });
    expect(r.outputStatus).toBe("unavailable");
    expect(r.usageMetadata.output_tokens).toBeUndefined();
    expect(r.outputUnavailableReason).toContain("no separable `result` field");
  });
});

describe("extractCursorPrompt - positional prompt, flag handling, keyword filtering", () => {
  it("extracts a positional prompt after -p (a boolean flag that takes no value)", () => {
    expect(extractCursorPrompt(["cursor", "agent", "-p", "fix the auth bug"])).toBe("fix the auth bug");
    expect(extractCursorPrompt(["cursor", "agent", "--print", "-p", "hello world", "--force"])).toBe("hello world");
  });

  it("skips value-taking flags AND their values (e.g. --output-format json)", () => {
    expect(extractCursorPrompt(["cursor", "agent", "-p", "do X", "--output-format", "json"])).toBe("do X");
    // `--flag=value` inline form is a single token → not a value-consuming flag, value not swallowed.
    expect(extractCursorPrompt(["cursor", "agent", "--output-format=json", "-p", "do Y"])).toBe("do Y");
  });

  it("filters subcommand keywords (cursor / agent / run) out of the prompt", () => {
    expect(extractCursorPrompt(["cursor", "agent", "run", "-p", "real prompt"])).toBe("real prompt");
    expect(extractCursorPrompt(["cursor-agent", "chat", "-p", "another prompt"])).toBe("another prompt");
  });

  it("returns undefined when no prompt can be identified (only keywords/flags)", () => {
    expect(extractCursorPrompt(["cursor", "agent"])).toBeUndefined();
    expect(extractCursorPrompt(["cursor", "agent", "--output-format", "json"])).toBeUndefined();
    expect(extractCursorPrompt([])).toBeUndefined();
  });
});
