import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { importTraceFile } from "../../src/core/trace-intake.js";
import { parseTraceFile } from "../../src/core/trace-parser.js";
import { detectWaste } from "../../src/core/waste-detector.js";

function uniqueDirectory(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function writeJson(filePath: string, value: unknown): Promise<string> {
  await mkdir(join(filePath, ".."), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, content, "utf8");
  return content;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJsonl(filePath: string, events: unknown[]): Promise<string> {
  await mkdir(join(filePath, ".."), { recursive: true });
  const content = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  await writeFile(filePath, content, "utf8");
  return content;
}

describe("trace intake", () => {
  it("accepts valid AgentTrace input, preserves the source file, and writes all intake artifacts", async () => {
    const directory = uniqueDirectory("compaction-agent-trace-intake");
    const inputPath = join(directory, "source-trace.json");
    const outputDirectory = join(directory, "out");
    const originalContent = await writeJson(inputPath, {
      id: "trace_valid_agent_trace",
      title: "Valid AgentTrace intake",
      artifactVersion: "agent-trace-v1",
      source: "manual",
      createdAt: "2026-01-01T00:00:00.000Z",
      generatedAt: "2026-01-01T00:00:00.000Z",
      model: "placeholder-agent-model",
      messages: [
        {
          id: "msg_user",
          role: "user",
          content: "Analyze this local trace.",
          timestamp: "2026-01-01T00:00:00.000Z"
        }
      ]
    });

    const artifacts = await importTraceFile(inputPath, "agent-trace", outputDirectory);

    expect(artifacts.report.status).toBe("pass");
    expect(artifacts.report.output_trace_id).toBe("trace_valid_agent_trace");
    expect(artifacts.report.message_count).toBe(1);
    expect(artifacts.report.supported_format_detected).toBe(true);
    expect(artifacts.report.recommended_next_command).toBe(`compaction analyze ${join(outputDirectory, "captured-trace.json")}`);
    await expect(readFile(join(outputDirectory, "captured-trace.json"), "utf8")).resolves.toContain("trace_valid_agent_trace");
    await expect(readFile(join(outputDirectory, "intake-report.json"), "utf8")).resolves.toContain("recommended_next_command");
    await expect(readFile(join(outputDirectory, "intake-report.md"), "utf8")).resolves.toContain("# Trace Intake Report");
    await expect(readFile(inputPath, "utf8")).resolves.toBe(originalContent);
  });

  it("DOWNGRADES a self-declared real_captured import end-to-end: written trace is fixture-tier, report warns", async () => {
    const directory = uniqueDirectory("compaction-provenance-guard-intake");
    const inputPath = join(directory, "claimed-real.json");
    const outputDirectory = join(directory, "out");
    await writeJson(inputPath, {
      id: "trace_claimed_real",
      title: "Hand-authored file claiming real_captured",
      artifactVersion: "agent-trace-v1",
      source: "real_captured",
      createdAt: "2026-01-01T00:00:00.000Z",
      generatedAt: "2026-01-01T00:00:00.000Z",
      model: "placeholder-agent-model",
      messages: [
        {
          id: "msg_user",
          role: "user",
          content: "I typed real_captured but never captured anything.",
          timestamp: "2026-01-01T00:00:00.000Z"
        }
      ]
    });

    const artifacts = await importTraceFile(inputPath, "agent-trace", outputDirectory);

    // The import boundary cannot attest a runtime capture: the persisted trace is downgraded.
    expect(artifacts.report.status).toBe("warn");
    const writtenTrace = await parseTraceFile(join(outputDirectory, "captured-trace.json"));
    expect(writtenTrace.source).toBe("manual");
    expect(writtenTrace.source).not.toBe("real_captured");

    // The downgrade reason is recorded in both the JSON and markdown intake reports.
    const reportJson = await readFile(join(outputDirectory, "intake-report.json"), "utf8");
    const reportMd = await readFile(join(outputDirectory, "intake-report.md"), "utf8");
    expect(reportJson).toContain("Import provenance guard");
    expect(reportMd).toContain("Downgraded evidence tier to fixture");
  });

  it("normalizes simple messages with deterministic local IDs and timestamps", async () => {
    const directory = uniqueDirectory("compaction-messages-intake");
    const inputPath = join(directory, "messages.json");
    const outputDirectory = join(directory, "out");
    await writeJson(inputPath, {
      messages: [
        {
          role: "user",
          content: "Do not invent message content."
        },
        {
          id: "msg_existing",
          role: "assistant",
          content: "I will keep the original content.",
          timestamp: "2026-01-01T00:00:03.000Z"
        }
      ]
    });

    const artifacts = await importTraceFile(inputPath, "messages", outputDirectory);
    const normalizedTrace = await readJson<{ messages: Array<{ id: string; timestamp: string; content: string }> }>(
      join(outputDirectory, "captured-trace.json")
    );
    const report = await readJson<{ warnings: string[]; normalization_steps: string[]; status: string }>(
      join(outputDirectory, "intake-report.json")
    );

    expect(artifacts.report.status).toBe("warn");
    expect(report.status).toBe("warn");
    expect(normalizedTrace.messages[0]).toMatchObject({
      id: "msg_001",
      timestamp: "1970-01-01T00:00:00.000Z",
      content: "Do not invent message content."
    });
    expect(report.warnings.join("\n")).toContain("Generated deterministic message id msg_001");
    expect(report.warnings.join("\n")).toContain("Generated deterministic timestamp 1970-01-01T00:00:00.000Z");
    expect(report.normalization_steps.join("\n")).toContain("Converted simple messages into the internal AgentTrace format");
  });

  it("imports Codex exec JSONL through intake, preserves the source file, and writes analyzable AgentTrace output", async () => {
    const directory = uniqueDirectory("compaction-codex-jsonl-intake");
    const inputPath = join(directory, "codex.jsonl");
    const outputDirectory = join(directory, "out");
    const originalContent = await writeJsonl(inputPath, [
      { type: "thread.started", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "item.completed", item: { type: "agent_message", content: "I will run tests." }, timestamp: "2026-01-01T00:00:01.000Z" },
      { type: "item.completed", item: { type: "command_execution", command: "npm", args: ["test"], stdout: "PASS local tests" }, timestamp: "2026-01-01T00:00:02.000Z" },
      { type: "item.completed", item: { type: "command_execution", command: "npm", args: ["test"], stdout: "PASS local tests" }, timestamp: "2026-01-01T00:00:03.000Z" },
      { type: "item.completed", item: { type: "file_change", path: "README.md" }, timestamp: "2026-01-01T00:00:04.000Z" }
    ]);

    const artifacts = await importTraceFile(inputPath, "codex-exec-jsonl", outputDirectory);
    const report = await readJson<{ status: string; warnings: string[]; skipped_fields: string[]; source_metadata: Record<string, unknown> }>(
      artifacts.paths.intakeReportJsonPath
    );
    const normalizedTrace = await parseTraceFile(artifacts.paths.normalizedTracePath);

    expect(artifacts.report.status).toBe("warn");
    expect(report.status).toBe("warn");
    expect(report.warnings.join("\n")).toContain("does not launch Codex or call provider APIs");
    expect(report.skipped_fields).toContain("jsonl[0].thread.started");
    expect(report.skipped_fields).toContain("jsonl[4].item.completed/file_change");
    expect(report.source_metadata).toMatchObject({ adapter_id: "codex-exec-jsonl", parsed_format: "jsonl", provider_api_calls: false });
    expect(normalizedTrace.messages).toHaveLength(3);
    expect(detectWaste(normalizedTrace)).toHaveLength(1);
    await expect(readFile(inputPath, "utf8")).resolves.toBe(originalContent);
  });

  it("defaults Codex import to the weakest honest tier (manual/fixture) and only elevates to imported_local with operatorExport", async () => {
    const directory = uniqueDirectory("compaction-codex-jsonl-tier");
    const inputPath = join(directory, "codex.jsonl");
    await mkdir(directory, { recursive: true });
    await writeJsonl(inputPath, [
      { type: "item.completed", item: { type: "agent_message", content: "Imported." }, timestamp: "2026-01-01T00:00:01.000Z" },
      { type: "item.completed", item: { type: "command_execution", command: "npm", args: ["test"], stdout: "PASS" }, timestamp: "2026-01-01T00:00:02.000Z" }
    ]);

    // Default (no operator assertion): weakest honest tier - manual -> fixture.
    const defaultArtifacts = await importTraceFile(inputPath, "codex-exec-jsonl", join(directory, "out-default"));
    const defaultTrace = await parseTraceFile(defaultArtifacts.paths.normalizedTracePath);
    expect(defaultTrace.source).toBe("manual");
    expect(defaultArtifacts.report.source_metadata).toMatchObject({ operator_export_asserted: false, evidence_tier: "fixture" });

    // Explicit operator assertion: elevated to codex_import -> imported_local (still below real_captured).
    const operatorArtifacts = await importTraceFile(inputPath, "codex-exec-jsonl", join(directory, "out-operator"), {
      operatorExport: true
    });
    const operatorTrace = await parseTraceFile(operatorArtifacts.paths.normalizedTracePath);
    expect(operatorTrace.source).toBe("codex_import");
    expect(operatorTrace.source).not.toBe("real_captured");
    expect(operatorArtifacts.report.source_metadata).toMatchObject({ operator_export_asserted: true, evidence_tier: "imported_local" });
  });

  it("fails malformed Codex JSONL intake clearly without normalized output", async () => {
    const directory = uniqueDirectory("compaction-codex-jsonl-malformed-intake");
    const inputPath = join(directory, "codex.jsonl");
    const outputDirectory = join(directory, "out");
    await mkdir(directory, { recursive: true });
    await writeFile(inputPath, '{"type":"thread.started"}\nnot-json\n', "utf8");

    const artifacts = await importTraceFile(inputPath, "codex-exec-jsonl", outputDirectory);

    expect(artifacts.report.status).toBe("fail");
    expect(artifacts.report.failures.join("\n")).toContain("JSONL line 2 is not valid JSON");
    expect(artifacts.normalizedTrace).toBeNull();
    await expect(readFile(artifacts.paths.normalizedTracePath, "utf8")).rejects.toThrow();
  });

  it("fails unsupported unknown input clearly and writes JSON and Markdown reports without a normalized trace", async () => {
    const directory = uniqueDirectory("compaction-unsupported-intake");
    const inputPath = join(directory, "unsupported.json");
    const outputDirectory = join(directory, "out");
    await writeJson(inputPath, { not_messages: true, count: 1 });

    const artifacts = await importTraceFile(inputPath, "unknown", outputDirectory);
    const report = await readJson<{ status: string; failures: string[]; recommended_next_command: string | null }>(
      join(outputDirectory, "intake-report.json")
    );
    const markdown = await readFile(join(outputDirectory, "intake-report.md"), "utf8");

    expect(artifacts.normalizedTrace).toBeNull();
    expect(report.status).toBe("fail");
    expect(report.failures.join("\n")).toContain("does not resemble AgentTrace, simple messages JSON, or Codex exec JSONL");
    expect(report.recommended_next_command).toBeNull();
    expect(markdown).toContain("## Failures");
    await expect(readFile(join(outputDirectory, "captured-trace.json"), "utf8")).rejects.toThrow();
  });

  it("detects supported formats when source is unknown and recommends analyze for the normalized trace", async () => {
    const directory = uniqueDirectory("compaction-unknown-detect-intake");
    const inputPath = join(directory, "messages.json");
    const outputDirectory = join(directory, "out");
    await writeJson(inputPath, [
      {
        id: "msg_user",
        role: "user",
        content: "Analyze imported local messages.",
        timestamp: "2026-01-01T00:00:00.000Z"
      }
    ]);

    const artifacts = await importTraceFile(inputPath, "unknown", outputDirectory);

    expect(artifacts.report.status).toBe("pass");
    expect(artifacts.report.supported_format_detected).toBe(true);
    expect(artifacts.report.recommended_next_command).toBe(`compaction analyze ${join(outputDirectory, "captured-trace.json")}`);
  });

  it("does not perform provider, network, database, auth, billing, hosted service, dashboard, or model routing work", async () => {
    const directory = uniqueDirectory("compaction-local-only-intake");
    const inputPath = join(directory, "messages.json");
    const outputDirectory = join(directory, "out");
    await writeJson(inputPath, [
      {
        role: "user",
        content: "This local import should only read and write files."
      }
    ]);

    const artifacts = await importTraceFile(inputPath, "messages", outputDirectory);
    const markdown = await readFile(join(outputDirectory, "intake-report.md"), "utf8");

    expect(artifacts.report.status).toBe("warn");
    expect(markdown).toContain("local and file-based only");
    expect(markdown).toContain("does not upload data or call model/provider APIs");
    expect(markdown).toContain("Live provider/runtime integrations are future work");
  });
});
