import { describe, expect, it } from "vitest";
import { normalizeCodexExecEvents, captureCodexExport, parseCodexEvents } from "../../src/core/codex-capture.js";

/**
 * Codex live-wrapper normalizer. Exercises the DOCUMENTED
 * `codex exec --json` event schema on synthetic fixtures; real-artifact validation against a true
 * `codex exec --json` run remains OPEN (operator-side), like the Codex import path.
 */

// Synthetic but schema-accurate codex exec --json JSONL (per OpenAI Codex non-interactive docs).
const STREAM = [
  `{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"docs\\nsdk\\nexamples\\n","status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}`,
  `{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":7}}`
].join("\n");

describe("normalizeCodexExecEvents - provider-reported usage from turn.completed", () => {
  it("extracts PROVIDER-REPORTED input/output/cached/reasoning tokens (never invented)", () => {
    const r = normalizeCodexExecEvents({ captureId: "t1", rawOutput: STREAM });
    expect(r.tokenMetadataStatus).toBe("present");
    expect(r.usageMetadata.provider_reported_tokens).toBe(true);
    expect(r.usageMetadata.estimated_tokens).toBe(false);
    expect(r.usageMetadata.input_tokens).toBe(24763);
    expect(r.usageMetadata.output_tokens).toBe(122);
    expect(r.usageMetadata.cache_read_input_tokens).toBe(24448); // cached_input_tokens → cache read
    expect(r.usageMetadata.total_tokens).toBe(24763 + 122); // reasoning is already a subset of output
    expect(r.usageMetadata.provider).toBe("openai");
    // Tokens are provider-reported, but no COST/pricing is known for the unknown model → cost stays
    // honestly "unknown" (we never synthesize a cost from provider-reported tokens alone).
    expect(r.usageMetadata.cost_source).toBe("unknown");
  });

  it("normalizes the trace as source=local_command with the codex thread id, content from item.completed", () => {
    const r = normalizeCodexExecEvents({ captureId: "t1", rawOutput: STREAM });
    expect(r.trace.source).toBe("local_command");
    expect(r.trace.id).toBe("0199a213-81c0-7800-8aa1-bbab2a035a53");
    // agent_message → assistant; command_execution output → tool message.
    const roles = r.trace.messages.map((m) => m.role);
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");
    expect(r.toolOutputsCaptured).toBe(1);
    expect(JSON.stringify(r.trace.messages)).toContain("Repo contains docs, sdk, and examples");
  });

  it("does NOT invent tokens when no usage block is present (honest missing)", () => {
    const noUsage = [
      `{"type":"thread.started","thread_id":"x"}`,
      `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"hi"}}`,
      `{"type":"turn.completed"}`
    ].join("\n");
    const r = normalizeCodexExecEvents({ captureId: "t2", rawOutput: noUsage });
    expect(r.tokenMetadataStatus).toBe("missing");
    expect(r.usageMetadata.provider_reported_tokens).toBe(false);
    expect(r.usageMetadata.estimated_tokens).toBe(false);
    expect(r.usageMetadata.input_tokens).toBeUndefined();
    expect(r.warnings.join(" ")).toContain("not invented");
  });

  it("falls back to an honest unknown model when no model field is emitted", () => {
    const r = normalizeCodexExecEvents({ captureId: "t3", rawOutput: STREAM });
    expect(r.trace.model).toBe("codex-unknown-model");
  });

  it("captureCodexExport normalizes a saved JSONL string the same way", () => {
    const r = captureCodexExport(STREAM);
    expect(r.usageMetadata.provider_reported_tokens).toBe(true);
    expect(r.trace.source).toBe("local_command");
  });

  it("sums provider-reported usage across multiple turn.completed events", () => {
    const multiTurn = [
      `{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10,"cached_input_tokens":5,"reasoning_output_tokens":1}}`,
      `{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":20,"cached_input_tokens":15,"reasoning_output_tokens":2}}`
    ].join("\n");
    const r = normalizeCodexExecEvents({ captureId: "t4", rawOutput: multiTurn });
    expect(r.usageMetadata.provider_reported_tokens).toBe(true);
    expect(r.usageMetadata.input_tokens).toBe(300);
    expect(r.usageMetadata.output_tokens).toBe(30);
    expect(r.usageMetadata.cache_read_input_tokens).toBe(20);
    expect(r.usageMetadata.total_tokens).toBe(300 + 30);
  });

  it("does not add the reasoning subset again for closed usage counts", () => {
    const rawOutput = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 9502, cached_input_tokens: 0, output_tokens: 24, reasoning_output_tokens: 17 }
    });
    const r = normalizeCodexExecEvents({ captureId: "reasoning-subset", rawOutput });
    expect(r.usageMetadata.input_tokens).toBe(9502);
    expect(r.usageMetadata.output_tokens).toBe(24);
    expect(r.usageMetadata.total_tokens).toBe(9526);
    expect(r.usageMetadata.limitations.some((note) => note.includes("Reasoning output tokens"))).toBe(true);
  });

  it.each([undefined, 0])("preserves totals with reasoning_output_tokens=%s", (reasoning) => {
    const rawOutput = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 10, reasoning_output_tokens: reasoning }
    });
    const r = normalizeCodexExecEvents({ captureId: "no-reasoning-subset", rawOutput });
    expect(r.usageMetadata.total_tokens).toBe(110);
    expect(r.usageMetadata.limitations.some((note) => note.includes("Reasoning output tokens"))).toBe(false);
  });

  it("parseCodexEvents ignores non-JSON noise lines", () => {
    const noisy = ["Codex starting…", STREAM, "done."].join("\n");
    expect(parseCodexEvents(noisy).length).toBe(6);
  });
});

describe("committed SYNTHETIC demo fixture (src/examples/codex-exec-demo.jsonl)", () => {
  // Dogfood friction: the committed fixture must be usage-bearing so the flagship
  // "live (provider-reported)" tier is demonstrable from the repo, via `run codex --export` -
  // without a real Codex run. The values are clearly-synthetic round demo numbers; this test
  // locks BOTH that the usage parses provider-reported AND that the fixture's messages are
  // consumable (fixture-compat fallback keys: agent_message `content`, command `stdout`).
  it("parses with PROVIDER-REPORTED usage and non-empty messages (provider-reported tier demonstrable)", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(new URL("../../src/examples/codex-exec-demo.jsonl", import.meta.url), "utf8");
    const r = captureCodexExport(raw);
    expect(r.tokenMetadataStatus).toBe("present");
    expect(r.usageMetadata.provider_reported_tokens).toBe(true);
    expect(r.usageMetadata.estimated_tokens).toBe(false);
    // Clearly-synthetic round demo numbers (see src/examples/CODEX-DEMO-README.md).
    expect(r.usageMetadata.input_tokens).toBe(24000);
    expect(r.usageMetadata.output_tokens).toBe(1800);
    expect(r.usageMetadata.cache_read_input_tokens).toBe(16000);
    expect(r.usageMetadata.total_tokens).toBe(24000 + 1800);
    // The fixture's messages must be consumable so the demo compaction has real content to act on.
    const roles = r.trace.messages.map((m) => m.role);
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");
    expect(r.toolOutputsCaptured).toBeGreaterThanOrEqual(3); // three repeated npm-test outputs
    // Synthetic marker: the thread id names the demo, never a realistic-looking session id.
    expect(r.trace.id).toBe("thread_codex_mvp_demo");
  });

  it("fixture-compat fallbacks never shadow the vendor fields on a real-shaped export", () => {
    // A real-shaped event carrying BOTH the vendor field and a stray fallback key must resolve
    // to the vendor field, real `codex exec --json` export parsing is unchanged.
    const stream = [
      `{"type":"item.completed","item":{"type":"agent_message","text":"vendor text","content":"fallback content"}}`,
      `{"type":"item.completed","item":{"type":"command_execution","command":"ls","aggregated_output":"vendor output","stdout":"fallback stdout"}}`,
      `{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":1}}`
    ].join("\n");
    const r = normalizeCodexExecEvents({ captureId: "t5", rawOutput: stream });
    const contents = r.trace.messages.map((m) => m.content);
    expect(contents).toContain("vendor text");
    expect(contents).toContain("vendor output");
    expect(contents).not.toContain("fallback content");
    expect(contents).not.toContain("fallback stdout");
  });
});
