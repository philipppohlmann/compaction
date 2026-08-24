import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  agentTraceAdapter,
  codexExecJsonlAdapter,
  detectTraceAdapter,
  getTraceAdapter,
  listTraceAdapterSources,
  messagesAdapter,
  unknownAdapter
} from "../../src/core/trace-adapters.js";
import { agentTraceSchema } from "../../src/core/trace-parser.js";
import { approvalReadinessStatusFromReport, evidenceSourceTypeFromTrace } from "../../src/core/safety-report.js";
import type { AgentTrace } from "../../src/core/types.js";

const validAgentTrace = {
  id: "trace_adapter_contract",
  title: "Trace adapter contract test",
  artifactVersion: "agent-trace-v1",
  source: "manual",
  createdAt: "2026-01-01T00:00:00.000Z",
  generatedAt: "2026-01-01T00:00:00.000Z",
  model: "local-test-model",
  messages: [
    {
      id: "msg_user",
      role: "user",
      content: "Verify the adapter contract.",
      timestamp: "2026-01-01T00:00:00.000Z"
    }
  ]
};

describe("trace adapters", () => {
  it("registers the v0 local source adapters", () => {
    expect(listTraceAdapterSources()).toEqual(["agent-trace", "messages", "codex-exec-jsonl", "unknown"]);
    expect(getTraceAdapter("agent-trace")).toBe(agentTraceAdapter);
    expect(getTraceAdapter("messages")).toBe(messagesAdapter);
    expect(getTraceAdapter("codex-exec-jsonl")).toBe(codexExecJsonlAdapter);
    expect(getTraceAdapter("unknown")).toBe(unknownAdapter);
  });

  it("agent-trace adapter accepts valid internal AgentTrace input", () => {
    expect(agentTraceAdapter.canHandle(validAgentTrace)).toBe(true);

    const result = agentTraceAdapter.normalize(validAgentTrace, { rawContent: JSON.stringify(validAgentTrace) });

    expect(result.status).toBe("pass");
    expect(result.trace?.id).toBe("trace_adapter_contract");
    expect(result.warnings).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.normalization_steps.join("\n")).toContain("Validated input as the internal AgentTrace JSON shape");
    expect(result.skipped_fields).toEqual([]);
    expect(result.source_metadata).toMatchObject({
      adapter_id: "agent-trace",
      supported_source: "agent-trace",
      local_file_normalizer: true,
      live_provider_integration: false
    });
  });

  it("messages adapter normalizes simple message input and reports warnings", () => {
    const input = {
      messages: [
        {
          role: "user",
          content: "Normalize this without provider calls.",
          provider_payload: { ignored: true }
        }
      ]
    };

    const result = messagesAdapter.normalize(input, { rawContent: JSON.stringify(input) });

    expect(result.status).toBe("warn");
    expect(result.trace?.messages[0]).toMatchObject({
      id: "msg_001",
      role: "user",
      content: "Normalize this without provider calls.",
      timestamp: "1970-01-01T00:00:00.000Z"
    });
    expect(result.warnings.join("\n")).toContain("Generated deterministic message id msg_001");
    expect(result.failures).toEqual([]);
    expect(result.normalization_steps.join("\n")).toContain("Converted simple messages into the internal AgentTrace format");
    expect(result.skipped_fields).toContain("messages[0].provider_payload");
    expect(result.source_metadata).toMatchObject({
      adapter_id: "messages",
      normalized_message_count: 1,
      live_provider_integration: false
    });
  });

  it("codex-exec-jsonl adapter accepts valid local JSONL events and produces normalized AgentTrace", () => {
    const rawContent = [
      JSON.stringify({ type: "thread.started", timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", content: "I will run the local tests." }, timestamp: "2026-01-01T00:00:01.000Z" }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm", args: ["test"], stdout: "PASS trace-adapters" }, timestamp: "2026-01-01T00:00:02.000Z" }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "private reasoning is not mapped" }, timestamp: "2026-01-01T00:00:03.000Z" })
    ].join("\n");
    const input = rawContent.split("\n").map((line, index) => ({ rawLineNumber: index + 1, event: JSON.parse(line) as unknown }));

    expect(codexExecJsonlAdapter.canHandle(input)).toBe(true);
    const result = codexExecJsonlAdapter.normalize(input, { rawContent });

    expect(result.status).toBe("warn");
    expect(result.trace).toMatchObject({
      title: "Imported Codex exec JSONL trace",
      artifactVersion: "agent-trace-v1",
      // Weakest-honest-default: WITHOUT an explicit operator provenance assertion
      // (`--operator-export` / `operatorExport`), a Codex JSONL import defaults to the
      // weakest honest tier, `manual` (evidence tier `fixture`), NOT `codex_import`.
      // Synthetic/demo/example inputs must not be over-labeled as a real local export.
      source: "manual",
      model: "codex-exec-jsonl-local-export"
    });
    expect(result.trace?.messages).toHaveLength(2);
    expect(result.trace?.messages[0]).toMatchObject({ role: "assistant", content: "I will run the local tests." });
    expect(result.trace?.messages[1]).toMatchObject({ role: "tool", toolName: "codex_command_execution" });
    expect(result.trace?.messages[0].metadata).toMatchObject({ source_line: 2, event_type: "item.completed", item_type: "agent_message" });
    expect(result.warnings.join("\n")).toContain("does not launch Codex or call provider APIs");
    expect(result.warnings.join("\n")).toContain("Skipped unsupported Codex JSONL event at line 4");
    expect(result.skipped_fields).toContain("jsonl[0].thread.started");
    expect(result.skipped_fields).toContain("jsonl[3].item.completed/reasoning");
    expect(result.source_metadata).toMatchObject({
      adapter_id: "codex-exec-jsonl",
      normalized_message_count: 2,
      provider_api_calls: false,
      live_provider_integration: false
    });
  });

  it("codex-exec-jsonl adapter rejects unsupported JSONL input clearly", () => {
    const input = [{ rawLineNumber: 1, event: { type: "item.completed", item: { type: "file_change", path: "README.md" } } }];
    const result = codexExecJsonlAdapter.normalize(input, { rawContent: JSON.stringify(input[0].event) });

    expect(result.status).toBe("fail");
    expect(result.trace).toBeNull();
    expect(result.failures.join("\n")).toContain("No supported Codex agent message, command, or tool events");
    expect(result.skipped_fields).toContain("jsonl[0].item.completed/file_change");
  });

  it("unknown adapter detects supported shapes where possible", () => {
    const input = [
      {
        id: "msg_user",
        role: "user",
        content: "Detect messages through unknown source.",
        timestamp: "2026-01-01T00:00:00.000Z"
      }
    ];

    expect(unknownAdapter.canHandle(input)).toBe(true);
    const detection = detectTraceAdapter(input, "unknown");
    const result = unknownAdapter.normalize(input, { rawContent: JSON.stringify(input) });

    expect(detection.status).toBe("pass");
    expect(detection.adapter_id).toBe("messages");
    expect(result.status).toBe("pass");
    expect(result.trace?.messages).toHaveLength(1);
    expect(result.normalization_steps[0]).toBe("Detected messages input while source was unknown.");
    expect(result.source_metadata).toMatchObject({
      adapter_id: "unknown",
      delegated_adapter_id: "messages",
      requested_source: "unknown"
    });
  });

  it("unsupported input fails clearly and includes failures in the adapter result", () => {
    const input = { not_messages: true, count: 1 };

    expect(unknownAdapter.canHandle(input)).toBe(false);
    const result = unknownAdapter.normalize(input, { rawContent: JSON.stringify(input) });

    expect(result.status).toBe("fail");
    expect(result.trace).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(result.failures.join("\n")).toContain("does not resemble AgentTrace, simple messages JSON, or Codex exec JSONL");
    expect(result.normalization_steps.join("\n")).toContain("Attempted to detect a supported local trace adapter");
    expect(result.source_metadata).toMatchObject({
      adapter_id: "unknown",
      detected_adapter_id: null,
      live_provider_integration: false
    });
  });

  it("does not introduce network or provider API calls in the adapter implementation", async () => {
    const adapterSource = await readFile("src/core/trace-adapters.ts", "utf8");

    expect(adapterSource).not.toMatch(/from "node:(http|https|net|tls)"/);
    expect(adapterSource).not.toMatch(/fetch\s*\(/);
    expect(adapterSource).not.toMatch(/api\.openai\.com|anthropic\.com|provider proxy/i);
  });

});

describe("codex import -> opt-in imported_local evidence tier (WS-A)", () => {
  const codexJsonl = [
    JSON.stringify({ type: "thread.started", timestamp: "2026-01-01T00:00:00.000Z" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", content: "Importing a real local codex export." }, timestamp: "2026-01-01T00:00:01.000Z" }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm", args: ["test"], stdout: "PASS" }, timestamp: "2026-01-01T00:00:02.000Z" })
  ].join("\n");

  function importedCodexTrace(operatorExport: boolean): AgentTrace {
    const input = codexJsonl.split("\n").map((line, index) => ({ rawLineNumber: index + 1, event: JSON.parse(line) as unknown }));
    const result = codexExecJsonlAdapter.normalize(input, { rawContent: codexJsonl, operatorExport });
    expect(result.trace).not.toBeNull();
    return result.trace as AgentTrace;
  }

  it("WITHOUT --operator-export defaults to the weakest honest tier: manual -> fixture, NOT imported_local", () => {
    const trace = importedCodexTrace(false);
    expect(trace.source).toBe("manual");

    const evidenceType = evidenceSourceTypeFromTrace(trace.source);
    expect(evidenceType).toBe("fixture");
    expect(evidenceType).not.toBe("imported_local");
    expect(evidenceType).not.toBe("real_captured");
  });

  it("WITH --operator-export elevates to codex_import -> imported_local, and NOT real_captured", () => {
    const trace = importedCodexTrace(true);
    expect(trace.source).toBe("codex_import");

    const evidenceType = evidenceSourceTypeFromTrace(trace.source);
    expect(evidenceType).toBe("imported_local");
    // The whole point of the honesty gate: imported_local does NOT count as real_captured.
    expect(evidenceType).not.toBe("real_captured");
  });

  it("imported codex_import trace PASSES agentTraceSchema (no command-trace rejection)", () => {
    const trace = importedCodexTrace(true);
    // No command/exitCode/durationMs provenance is present; this must still validate
    // because codex_import is intentionally excluded from command-trace validation.
    expect(trace.command).toBeUndefined();
    expect(trace.exitCode).toBeUndefined();
    expect(trace.durationMs).toBeUndefined();

    const parsed = agentTraceSchema.safeParse(trace);
    expect(parsed.success).toBe(true);
  });

  it("imported_local stays strictly BELOW real_captured: approval readiness caps at conditional, never ready", () => {
    const evidenceType = evidenceSourceTypeFromTrace("codex_import");
    expect(evidenceType).toBe("imported_local");

    // Even with the strongest reviewer + a review summary on a passing report, an
    // imported_local trace can only reach "conditional", only real_captured unlocks "ready".
    expect(approvalReadinessStatusFromReport("pass", evidenceType, "human", true)).toBe("conditional");
    expect(approvalReadinessStatusFromReport("pass", evidenceType, "independent", true)).toBe("conditional");
    expect(approvalReadinessStatusFromReport("pass", "real_captured", "human", true)).toBe("ready");
  });

  it("emits NO billing-confirmed and NO semantic/commitment-preservation claim on the codex_import path", () => {
    const input = codexJsonl.split("\n").map((line, index) => ({ rawLineNumber: index + 1, event: JSON.parse(line) as unknown }));
    const result = codexExecJsonlAdapter.normalize(input, { rawContent: codexJsonl, operatorExport: true });

    const allText = [
      ...result.warnings,
      ...result.normalization_steps,
      ...result.failures,
      JSON.stringify(result.source_metadata),
      JSON.stringify(result.trace)
    ]
      .join("\n")
      .toLowerCase();

    expect(allText).not.toContain("billing-confirmed");
    expect(allText).not.toContain("billing confirmed");
    expect(allText).not.toContain("provider-reported");
    expect(allText).not.toContain("semantic equivalence");
    expect(allText).not.toContain("commitment preserv");
    expect(allText).not.toContain("commitments preserv");
    expect(allText).not.toContain("real_captured");
    expect(allText).not.toContain("real captured");
  });
});

describe("agent-trace import provenance guard", () => {
  function agentTraceDeclaring(source: string): Record<string, unknown> {
    return {
      id: `trace_${source}`,
      title: `AgentTrace declaring ${source}`,
      artifactVersion: "agent-trace-v1",
      source,
      createdAt: "2026-01-01T00:00:00.000Z",
      generatedAt: "2026-01-01T00:00:00.000Z",
      model: "local-test-model",
      messages: [
        {
          id: "msg_user",
          role: "user",
          content: "Imported, not captured.",
          timestamp: "2026-01-01T00:00:00.000Z"
        }
      ]
    };
  }

  it("DOWNGRADES a self-declared real_captured import to fixture (source: manual), never inheriting the capture tier", () => {
    const input = agentTraceDeclaring("real_captured");
    const result = agentTraceAdapter.normalize(input, { rawContent: JSON.stringify(input) });

    // The import boundary cannot attest a runtime capture, so the declared tier is stripped.
    expect(result.trace?.source).toBe("manual");
    expect(result.trace?.source).not.toBe("real_captured");

    // The honest evidence tier is fixture, and it can NEVER unlock the "ready" rung.
    const evidenceType = evidenceSourceTypeFromTrace(result.trace!.source);
    expect(evidenceType).toBe("fixture");
    expect(evidenceType).not.toBe("real_captured");
    expect(approvalReadinessStatusFromReport("pass", evidenceType, "human", true)).toBe("conditional");

    // The downgrade is surfaced honestly: warn status, a warning, a recorded normalization step.
    expect(result.status).toBe("warn");
    expect(result.warnings.join("\n")).toContain("Import provenance guard");
    expect(result.normalization_steps.join("\n")).toContain("Downgraded evidence tier to fixture");
    expect(result.source_metadata).toMatchObject({
      declared_source: "real_captured",
      effective_source: "manual",
      provenance_guard_applied: true
    });
  });

  it("DOWNGRADES a self-declared demo import to fixture (source: manual)", () => {
    const input = agentTraceDeclaring("demo");
    const result = agentTraceAdapter.normalize(input, { rawContent: JSON.stringify(input) });

    expect(result.trace?.source).toBe("manual");
    expect(result.status).toBe("warn");
    expect(evidenceSourceTypeFromTrace(result.trace!.source)).toBe("fixture");
  });

  it("the unknown-source detection path ALSO applies the guard (real_captured -> fixture)", () => {
    const input = agentTraceDeclaring("real_captured");
    const result = unknownAdapter.normalize(input, { rawContent: JSON.stringify(input) });

    expect(result.trace?.source).toBe("manual");
    expect(evidenceSourceTypeFromTrace(result.trace!.source)).not.toBe("real_captured");
  });

  it("PRESERVES an honest declared source that the import boundary CAN carry (manual stays manual, no guard)", () => {
    const input = agentTraceDeclaring("manual");
    const result = agentTraceAdapter.normalize(input, { rawContent: JSON.stringify(input) });

    expect(result.trace?.source).toBe("manual");
    expect(result.status).toBe("pass");
    expect(result.warnings).toEqual([]);
    expect(result.source_metadata).toMatchObject({ provenance_guard_applied: false });
  });

  it("PRESERVES a declared imported_local-family source unchanged (cli_wrapper is not downgraded by this guard)", () => {
    // cli_wrapper requires command-trace metadata to validate; provide it so the schema passes,
    // then assert the guard leaves the honest imported_local tier intact (only real_captured/demo move).
    const input = {
      ...agentTraceDeclaring("cli_wrapper"),
      command: { command: "node", args: ["script.js"] },
      exitCode: 0,
      durationMs: 5
    };
    const result = agentTraceAdapter.normalize(input, { rawContent: JSON.stringify(input) });

    expect(result.trace?.source).toBe("cli_wrapper");
    expect(result.status).toBe("pass");
    expect(evidenceSourceTypeFromTrace(result.trace!.source)).toBe("imported_local");
  });
});

describe("import source readiness labels (V0.3 - honest integration-readiness)", () => {
  const adapters = [agentTraceAdapter, messagesAdapter, codexExecJsonlAdapter, unknownAdapter];

  it("every source carries a non-empty Level-1 (local import) readiness label", () => {
    for (const a of adapters) {
      expect(a.readiness, a.id).toBeTruthy();
      expect(a.readiness, a.id).toContain("Level 1");
    }
  });

  it("codex-exec-jsonl honestly discloses synthetic-fixture-only validation (real-artifact OPEN)", () => {
    const r = codexExecJsonlAdapter.readiness.toLowerCase();
    expect(r).toContain("synthetic fixture");
    expect(r).toContain("real-artifact validation open");
  });

  it("no source readiness OVERCLAIMS the integration", () => {
    for (const a of adapters) {
      const r = a.readiness.toLowerCase();
      expect(r, a.id).not.toMatch(/\bproduction\b/);
      expect(r, a.id).not.toMatch(/\bnative\b/);
      expect(r, a.id).not.toMatch(/\blive integration\b/);
      // "real-artifact validation" may appear ONLY as the honest "...OPEN" negation, never as a positive claim.
      const stripped = r.replace(/real-artifact validation open[^.]*/g, "");
      expect(stripped, a.id).not.toContain("real-artifact validat");
    }
  });
});
