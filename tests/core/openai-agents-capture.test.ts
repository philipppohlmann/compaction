import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureOpenAIAgentsCommand, captureOpenAIAgentsExport, normalizeOpenAIAgentsEvents } from "../../src/core/openai-agents-capture.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openai-agents-capture-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function fixtureEvents(): string {
  return [
    {
      type: "trace",
      id: "trace_fixture_openai_agents",
      workflow_name: "Fixture workflow",
      created_at: "2026-01-01T00:00:00.000Z"
    },
    {
      type: "span",
      trace_id: "trace_fixture_openai_agents",
      started_at: "2026-01-01T00:00:01.000Z",
      span_data: {
        type: "generation",
        model: "gpt-4.1-mini",
        input: [{ role: "user", content: "Use the fixture tool." }],
        output: [{ role: "assistant", content: "Calling the fixture tool now." }]
      }
    },
    {
      type: "span",
      trace_id: "trace_fixture_openai_agents",
      started_at: "2026-01-01T00:00:02.000Z",
      span_data: {
        type: "function",
        name: "fixture_tool",
        input: "{\"id\":\"safe\"}",
        output: "{\"result\":\"ok\"}"
      }
    }
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
}

describe("OpenAI Agents SDK capture spike", () => {
  it("generates capture report artifacts and a normalized AgentTrace from local export fixture events", async () => {
    const dir = await tempDir();
    const input = path.join(dir, "events.jsonl");
    await writeFile(input, fixtureEvents(), "utf8");

    const artifacts = await captureOpenAIAgentsExport(input, dir);

    expect(artifacts.report.integration).toBe("openai-agents");
    expect(artifacts.report.capture_mode).toBe("local export");
    expect(artifacts.report.output_trace_id).toBe("trace_fixture_openai_agents");
    expect(artifacts.report.events_captured).toBe(3);
    expect(artifacts.report.messages_captured).toBeGreaterThanOrEqual(3);
    expect(artifacts.report.tool_outputs_captured).toBe(1);
    expect(artifacts.report.recommended_next_command).toContain("compaction analyze");

    const trace = JSON.parse(await readFile(artifacts.paths.capturedTracePath, "utf8"));
    const reportJson = JSON.parse(await readFile(artifacts.paths.captureReportJsonPath, "utf8"));
    const reportMd = await readFile(artifacts.paths.captureReportMarkdownPath, "utf8");
    expect(trace.messages.some((message: { toolName?: string }) => message.toolName === "fixture_tool")).toBe(true);
    expect(reportJson.capture_id).toBe(artifacts.report.capture_id);
    expect(reportJson.usage_metadata.cost_source).toBe("missing");
    expect(reportJson.spend_confidence).toBe("unknown");
    expect(reportMd).toContain("# OpenAI Agents SDK Capture Report");
  });


  it("represents provider-reported token metadata when captured in events", () => {
    const event = {
      type: "span",
      trace_id: "trace_provider_usage",
      started_at: "2026-01-01T00:00:01.000Z",
      span_data: {
        type: "generation",
        provider: "openai",
        model: "placeholder-agent-model",
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
        input: [{ role: "user", content: "Use provider metadata." }],
        output: [{ role: "assistant", content: "Provider metadata captured." }]
      }
    };

    const result = normalizeOpenAIAgentsEvents({
      captureId: "capture_provider_usage",
      rawOutput: JSON.stringify(event),
      generatedAt: "2026-01-01T00:00:05.000Z"
    });

    expect(result.tokenMetadataStatus).toBe("present");
    expect(result.usageMetadata).toMatchObject({
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20,
      provider_reported_tokens: true,
      estimated_tokens: false,
      cost_source: "price_table_estimate",
      cost_confidence: "medium",
      provider: "openai",
      model: "placeholder-agent-model"
    });
  });

  it("marks missing token and cost metadata honestly instead of inventing values", () => {
    const result = normalizeOpenAIAgentsEvents({
      captureId: "capture_missing_metadata",
      rawOutput: fixtureEvents(),
      generatedAt: "2026-01-01T00:00:05.000Z"
    });

    expect(result.tokenMetadataStatus).toBe("missing");
    expect(result.costMetadataStatus).toBe("missing");
    expect(result.usageMetadata.cost_source).toBe("missing");
    expect(result.usageMetadata.cost_confidence).toBe("unknown");
    expect(result.usageMetadata.input_tokens).toBeUndefined();
    expect(JSON.stringify(result.trace)).not.toMatch(/inputTokens|outputTokens|totalCostUsd|cost_usd/);
  });

  it("keeps the wrapped source command and input arguments unchanged", async () => {
    const dir = await tempDir();
    const script = path.join(dir, "emit-events.mjs");
    await writeFile(script, `console.log(${JSON.stringify(JSON.stringify({ type: "trace", id: "trace_command", workflow_name: "Command fixture" }))});`, "utf8");

    const artifacts = await captureOpenAIAgentsCommand(["node", script, "--kept", "value with spaces"], dir);

    expect(artifacts.report.command_run?.command).toBe("node");
    expect(artifacts.report.command_run?.args).toEqual([script, "--kept", "value with spaces"]);
    expect(artifacts.trace?.command?.command).toBe("node");
    expect(artifacts.trace?.command?.args).toEqual([script, "--kept", "value with spaces"]);
  });

  it("demo command works without real provider credentials", async () => {
    const dir = await tempDir();
    const artifacts = await captureOpenAIAgentsCommand(["node", "src/examples/openai-agents-capture-demo.js"], dir);

    expect(artifacts.report.status).toBe("warn");
    expect(artifacts.report.failures).toEqual([]);
    expect(artifacts.report.limitations.join(" ")).toContain("does not scrape ChatGPT");
    expect(artifacts.report.limitations.join(" ")).toContain("No hosted service");
  });

  it("does not add prohibited hosted product dependencies and documents excluded scope", async () => {
    const result = normalizeOpenAIAgentsEvents({
      captureId: "capture_scope_check",
      rawOutput: fixtureEvents(),
      generatedAt: "2026-01-01T00:00:05.000Z"
    });

    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const dependencies = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
    expect(dependencies).not.toContain("express");
    expect(dependencies).not.toContain("next");
    expect(dependencies).not.toContain("vite");
    expect(dependencies).not.toContain("@prisma/client");
    expect(result.limitations.join(" ")).toContain("No hosted service, dashboard, database, auth, billing, model routing");
  });
});
