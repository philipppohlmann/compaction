import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AgentTrace } from "./types.js";

export const CURRENT_AGENT_TRACE_ARTIFACT_VERSION = "agent-trace-v1";

const isoTimestampSchema = z.string().datetime({ offset: true });

const traceMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["system", "user", "assistant", "tool", "stdout", "stderr"]),
  content: z.string(),
  timestamp: isoTimestampSchema,
  toolName: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional()
});

const commandMetadataSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1).optional(),
  shell: z.string().min(1).optional()
});

// `codex_import` (and `cursor_import`) are deliberately NOT command traces: an imported
// `codex exec --json` JSONL / Cursor session export carries no command/exitCode/durationMs
// provenance, so they must not be subjected to command-trace validation (that is why the
// import paths could not reuse `cli_wrapper`/`local_command`). Keep this exclusion in
// lockstep with the `imported_local` evidence mapping in safety-report.ts.
function isCommandTrace(source: string | undefined): boolean {
  return source === "cli_wrapper" || source === "local_command";
}

const rawAgentTraceSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    artifactVersion: z.string().min(1).optional(),
    artifact_version: z.string().min(1).optional(),
    source: z.enum(["manual", "cli_wrapper", "local_command", "demo", "real_captured", "provider_usage", "codex_import", "cursor_import"]).optional(),
    createdAt: isoTimestampSchema.optional(),
    created_at: isoTimestampSchema.optional(),
    generatedAt: isoTimestampSchema.optional(),
    generated_at: isoTimestampSchema.optional(),
    model: z.string().min(1),
    command: commandMetadataSchema.optional(),
    durationMs: z.number().int().nonnegative().optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().min(0).max(255).optional(),
    exit_code: z.number().int().min(0).max(255).optional(),
    messages: z.array(traceMessageSchema)
  })
  .superRefine((trace, context) => {
    const createdAt = trace.createdAt ?? trace.created_at;
    const generatedAt = trace.generatedAt ?? trace.generated_at;

    if (!createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Trace must include createdAt or created_at.",
        path: ["createdAt"]
      });
    }

    if (trace.createdAt && trace.created_at && trace.createdAt !== trace.created_at) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "createdAt and created_at must match when both are present.",
        path: ["created_at"]
      });
    }

    if (trace.generatedAt && trace.generated_at && trace.generatedAt !== trace.generated_at) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "generatedAt and generated_at must match when both are present.",
        path: ["generated_at"]
      });
    }

    if (trace.artifactVersion && trace.artifact_version && trace.artifactVersion !== trace.artifact_version) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "artifactVersion and artifact_version must match when both are present.",
        path: ["artifact_version"]
      });
    }

    if (trace.durationMs !== undefined && trace.duration_ms !== undefined && trace.durationMs !== trace.duration_ms) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "durationMs and duration_ms must match when both are present.",
        path: ["duration_ms"]
      });
    }

    if (trace.exitCode !== undefined && trace.exit_code !== undefined && trace.exitCode !== trace.exit_code) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exitCode and exit_code must match when both are present.",
        path: ["exit_code"]
      });
    }

    if (isCommandTrace(trace.source) && !trace.command) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Command traces must include command metadata.",
        path: ["command"]
      });
    }

    if (isCommandTrace(trace.source) && trace.exitCode === undefined && trace.exit_code === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Command traces must include exitCode or exit_code.",
        path: ["exitCode"]
      });
    }

    if (isCommandTrace(trace.source) && trace.durationMs === undefined && trace.duration_ms === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Command traces must include durationMs or duration_ms.",
        path: ["durationMs"]
      });
    }

    if (generatedAt && createdAt && new Date(generatedAt).getTime() < new Date(createdAt).getTime()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "generatedAt must not be earlier than createdAt.",
        path: ["generatedAt"]
      });
    }
  });

export const agentTraceSchema = rawAgentTraceSchema.transform((trace): AgentTrace => {
  const createdAt = trace.createdAt ?? trace.created_at;
  if (!createdAt) {
    throw new Error("Trace must include createdAt or created_at.");
  }

  return {
    id: trace.id,
    title: trace.title,
    artifactVersion: trace.artifactVersion ?? trace.artifact_version ?? CURRENT_AGENT_TRACE_ARTIFACT_VERSION,
    source: trace.source ?? "manual",
    createdAt,
    generatedAt: trace.generatedAt ?? trace.generated_at ?? createdAt,
    model: trace.model,
    command: trace.command,
    durationMs: trace.durationMs ?? trace.duration_ms,
    exitCode: trace.exitCode ?? trace.exit_code,
    messages: trace.messages
  };
});

export async function parseTraceFile(traceFile: string): Promise<AgentTrace> {
  const rawTrace = await readFile(traceFile, "utf8");
  return agentTraceSchema.parse(JSON.parse(rawTrace));
}
