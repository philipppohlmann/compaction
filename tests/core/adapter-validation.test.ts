import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { validateAdapterFixtureFile } from "../../src/core/adapter-validation.js";

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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("adapter fixture validation", () => {
  it("passes a valid fixture with the correct adapter and preserves the source file", async () => {
    const directory = uniqueDirectory("compaction-valid-adapter-fixture");
    const inputPath = join(directory, "source-trace.json");
    const outputRoot = join(directory, "validations");
    const originalContent = await writeJson(inputPath, {
      id: "trace_adapter_fixture_valid",
      title: "Valid adapter fixture",
      artifactVersion: "agent-trace-v1",
      source: "manual",
      createdAt: "2026-01-01T00:00:00.000Z",
      generatedAt: "2026-01-01T00:00:00.000Z",
      model: "local-fixture-model",
      messages: [
        {
          id: "msg_user",
          role: "user",
          content: "Validate this local fixture.",
          timestamp: "2026-01-01T00:00:00.000Z"
        }
      ]
    });

    const artifacts = await validateAdapterFixtureFile(inputPath, "agent-trace", outputRoot);
    const report = await readJson<{ status: string; adapter_id: string; supported_format_detected: boolean }>(
      artifacts.paths.validationReportJsonPath
    );

    expect(artifacts.report.status).toBe("pass");
    expect(report.status).toBe("pass");
    expect(report.adapter_id).toBe("agent-trace");
    expect(report.supported_format_detected).toBe(true);
    expect(artifacts.report.normalization_steps.join("\n")).toContain("Ran adapter canHandle");
    expect(artifacts.report.normalization_steps.join("\n")).toContain("Ran adapter normalize");
    await expect(readFile(artifacts.paths.normalizedTracePath, "utf8")).resolves.toContain("trace_adapter_fixture_valid");
    await expect(readFile(inputPath, "utf8")).resolves.toBe(originalContent);
  });

  it("validates Codex exec JSONL fixtures through the fixture harness and preserves the source file", async () => {
    const directory = uniqueDirectory("compaction-codex-jsonl-adapter-fixture");
    const inputPath = join(directory, "codex.jsonl");
    const outputRoot = join(directory, "validations");
    const originalContent = await writeJsonl(inputPath, [
      { type: "thread.started", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "item.completed", item: { type: "agent_message", content: "I will inspect the repo." }, timestamp: "2026-01-01T00:00:01.000Z" },
      { type: "item.completed", item: { type: "command_execution", command: "git", args: ["status", "--short"], stdout: "" }, timestamp: "2026-01-01T00:00:02.000Z" },
      { type: "item.completed", item: { type: "web_search", query: "not mapped in v0" }, timestamp: "2026-01-01T00:00:03.000Z" }
    ]);

    const artifacts = await validateAdapterFixtureFile(inputPath, "codex-exec-jsonl", outputRoot);
    const report = await readJson<{
      status: string;
      adapter_id: string;
      warnings: string[];
      skipped_fields: string[];
      normalization_steps: string[];
    }>(artifacts.paths.validationReportJsonPath);
    const markdown = await readFile(artifacts.paths.validationReportMarkdownPath, "utf8");
    const normalizedTrace = await readJson<{ model: string; messages: Array<{ role: string; metadata?: Record<string, unknown> }> }>(
      artifacts.paths.normalizedTracePath
    );

    expect(report.status).toBe("warn");
    expect(report.adapter_id).toBe("codex-exec-jsonl");
    expect(report.warnings.join("\n")).toContain("does not launch Codex or call provider APIs");
    expect(report.skipped_fields).toContain("jsonl[0].thread.started");
    expect(report.skipped_fields).toContain("jsonl[3].item.completed/web_search");
    expect(report.normalization_steps.join("\n")).toContain("Parsed local Codex exec JSONL content line by line");
    expect(normalizedTrace.model).toBe("codex-exec-jsonl-local-export");
    expect(normalizedTrace.messages[0].metadata).toMatchObject({ source_line: 2, raw_event_hash: expect.any(String) });
    expect(markdown).toContain("Codex exec JSONL");
    expect(markdown).toContain("Live provider/runtime integration: no");
    await expect(readFile(inputPath, "utf8")).resolves.toBe(originalContent);
  });

  it("fails malformed Codex exec JSONL fixtures clearly", async () => {
    const directory = uniqueDirectory("compaction-codex-jsonl-bad-fixture");
    const inputPath = join(directory, "codex.jsonl");
    const outputRoot = join(directory, "validations");
    await mkdir(directory, { recursive: true });
    await writeFile(inputPath, '{"type":"thread.started"}\nnot-json\n', "utf8");

    const artifacts = await validateAdapterFixtureFile(inputPath, "codex-exec-jsonl", outputRoot);

    expect(artifacts.report.status).toBe("fail");
    expect(artifacts.report.failures.join("\n")).toContain("JSONL line 2 is not valid JSON");
    await expect(fileExists(artifacts.paths.normalizedTracePath)).resolves.toBe(false);
  });

  it("fails unsupported sources clearly before writing validation artifacts", async () => {
    const directory = uniqueDirectory("compaction-unsupported-source-fixture");
    const inputPath = join(directory, "messages.json");
    await writeJson(inputPath, { messages: [{ role: "user", content: "Unsupported source should fail." }] });

    await expect(validateAdapterFixtureFile(inputPath, "claude-code", join(directory, "out"))).rejects.toThrow(
      "Unsupported source \"claude-code\""
    );
  });

  it("fails unsupported input shapes clearly and writes reports without a normalized trace", async () => {
    const directory = uniqueDirectory("compaction-unsupported-shape-fixture");
    const inputPath = join(directory, "unsupported.json");
    const outputRoot = join(directory, "validations");
    await writeJson(inputPath, { events: [{ kind: "not-a-message" }] });

    const artifacts = await validateAdapterFixtureFile(inputPath, "messages", outputRoot);
    const markdown = await readFile(artifacts.paths.validationReportMarkdownPath, "utf8");

    expect(artifacts.report.status).toBe("fail");
    expect(artifacts.report.supported_format_detected).toBe(false);
    expect(artifacts.report.failures.join("\n")).toContain("Adapter messages cannot handle this fixture shape");
    expect(markdown).toContain("# Adapter Validation Report");
    expect(markdown).toContain("## Failures");
    await expect(fileExists(artifacts.paths.normalizedTracePath)).resolves.toBe(false);
  });

  it("captures normalization warnings and writes JSON, Markdown, and normalized trace artifacts", async () => {
    const directory = uniqueDirectory("compaction-warning-fixture");
    const inputPath = join(directory, "messages.json");
    const outputRoot = join(directory, "validations");
    await writeJson(inputPath, {
      messages: [
        {
          role: "user",
          content: "Capture deterministic warnings.",
          provider_payload: { ignored: true }
        }
      ]
    });

    const artifacts = await validateAdapterFixtureFile(inputPath, "messages", outputRoot);
    const report = await readJson<{
      status: string;
      warnings: string[];
      skipped_fields: string[];
      recommended_next_command: string | null;
    }>(artifacts.paths.validationReportJsonPath);
    const markdown = await readFile(artifacts.paths.validationReportMarkdownPath, "utf8");
    const normalizedTrace = await readJson<{ messages: Array<{ id: string; timestamp: string }> }>(artifacts.paths.normalizedTracePath);

    expect(artifacts.report.status).toBe("warn");
    expect(report.status).toBe("warn");
    expect(report.warnings.join("\n")).toContain("Generated deterministic message id msg_001");
    expect(report.warnings.join("\n")).toContain("Generated deterministic timestamp 1970-01-01T00:00:00.000Z");
    expect(report.skipped_fields).toContain("messages[0].provider_payload");
    expect(normalizedTrace.messages[0]).toMatchObject({ id: "msg_001", timestamp: "1970-01-01T00:00:00.000Z" });
    expect(report.recommended_next_command).toBe(`compaction analyze ${artifacts.paths.normalizedTracePath}`);
    expect(markdown).toContain("## Recommended Next Command");
    expect(markdown).toContain(`compaction analyze ${artifacts.paths.normalizedTracePath}`);
  });

  it("records local-only limitations and avoids live provider/runtime work", async () => {
    const directory = uniqueDirectory("compaction-local-only-fixture");
    const inputPath = join(directory, "messages.json");
    const outputRoot = join(directory, "validations");
    await writeJson(inputPath, [{ role: "user", content: "Local validation only." }]);

    const artifacts = await validateAdapterFixtureFile(inputPath, "messages", outputRoot);
    const markdown = await readFile(artifacts.paths.validationReportMarkdownPath, "utf8");

    expect(artifacts.report.status).toBe("warn");
    expect(artifacts.report.limitations.join("\n")).toContain("local and file-based only");
    expect(artifacts.report.limitations.join("\n")).toContain("It does not upload data or call model/provider APIs");
    expect(markdown).toContain("Live provider/runtime integration: no");
    expect(markdown).toContain("not a live Claude Code, Codex, Cursor, OpenAI, Anthropic, LangChain, GitHub");
  });
});
