import type { AgentTrace } from "./types.js";
import type { UsageMetadata } from "./usage-metadata.js";
import type { TraceFingerprint } from "./trace-fingerprint.js";

export interface CaptureAdapter {
  /** Stable identifier for this adapter. Used in provenance and logging. */
  readonly id: string;

  /**
   * Normalize a raw input (session file path, event stream, export file, etc.)
   * into a CapturedRun containing a normalized AgentTrace, UsageMetadata,
   * and provenance information.
   *
   * The adapter is responsible for:
   * - Setting source: "real_captured" only when the trace comes from an agent
   *   runtime session with identifiable workflow context (see real_captured semantics).
   * - Attaching UsageMetadata at normalization time, not re-deriving it downstream.
   * - Setting provenance.captureAdapter to this adapter's id.
   */
  normalize(input: CaptureAdapterInput): Promise<CapturedRun>;
}

export interface CaptureAdapterInput {
  /** Path to the source artifact (session JSONL file, export file, stdout dump). */
  sourcePath: string;
  /** Human-readable label for CLI output. */
  label?: string;
  /** Additional adapter-specific options. */
  options?: Record<string, unknown>;
}

export interface CapturedRun {
  /** The normalized agent trace. */
  trace: AgentTrace;
  /** Usage metadata attached at capture time. Never re-derived downstream. */
  usage: UsageMetadata;
  /** Provenance record for the capture. */
  provenance: CaptureProvenance;
}

export interface CaptureSubagentProvenance {
  /** Unique agent identifier from the subagent JSONL entries. */
  agentId: string;
  /** Total user + assistant entries processed from this subagent. */
  entryCount: number;
  /** Agent type from meta.json, if present. */
  agentType?: string;
  /** Human-readable description from meta.json, if present. */
  description?: string;
  /** Tool use ID linking this subagent to the parent session tool call, from meta.json if present. */
  toolUseId?: string;
}

export interface CaptureProvenance {
  /** The adapter that produced this run. */
  captureAdapter: string;
  /** Stable source path or identifier. */
  sourcePath: string;
  /** ISO 8601 timestamp of when the capture was performed. */
  capturedAt: string;
  /** Claude Code session ID, OpenAI Agents run ID, or equivalent. Null if unknown. */
  sessionId: string | null;
  /** Any warnings or limitations the adapter encountered. */
  warnings: string[];
  /** Any limitations that apply to the captured run. */
  limitations: string[];
  /** Provenance records for each included subagent, when --include-subagents is used. */
  subagents?: CaptureSubagentProvenance[];
  /**
   * Non-sensitive per-run distinctness fingerprint (a one-way SHA-256 DIGEST over the
   * canonical normalized trace content, NEVER raw messages/prompts/tool-output).
   *
   * Lets future dogfood records cite a verifiable per-run distinctness proof so that
   * genuinely-different captured sessions are distinguishable from re-captures of the
   * same session (preventing real_captured N over-counting). When an adapter cannot
   * produce a fingerprint, this is omitted and distinctness must be reported as
   * `not_verified`, never counted as distinct. See `src/core/trace-fingerprint.ts`.
   */
  traceFingerprint?: TraceFingerprint;
}
