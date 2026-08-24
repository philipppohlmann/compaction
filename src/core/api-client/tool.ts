/**
 * Canonical coding-tool identity (PUBLIC CLI/SDK code).
 *
 * The single source of truth for the `tool` attribution value the CLI tags onto a recorded run.
 * It is CONTENT-FREE metadata, a short, fixed identifier of WHICH coding tool produced a captured
 * session (e.g. Claude Code vs Codex vs Cursor), never any prompt/completion/trace content.
 *
 * This union is hand-mirrored, with no cross-package import, by the `tool` enum in
 * `apps/api/src/schemas.ts` and the `tool` CHECK constraint in `apps/control-plane` migration
 * 0007 / 0008. Keep the five values in lock-step across all three.
 *
 * `cursor` is a first-class recognized value so a Cursor run records correctly the moment a Cursor
 * capture adapter lands. No live Cursor (or Codex) CAPTURE adapter ships today, Codex is import
 * only and Cursor's session format is not yet verified, so a real CLI capture currently resolves
 * to `claude-code` / `openai-agents`, or `other` when the source is unknown. The wire never carries
 * a tool the producing adapter did not actually set.
 */

export type ToolName = "claude-code" | "codex" | "cursor" | "openai-agents" | "other";

/** The five canonical tool values, in declaration order. */
export const TOOL_NAMES: readonly ToolName[] = [
  "claude-code",
  "codex",
  "cursor",
  "openai-agents",
  "other"
];

/** Narrowing guard: true iff `value` is one of the canonical tool names. */
export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && (TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * Resolve a CONTENT-FREE tool identifier from a capture-adapter id or a trace-source string
 * (e.g. `provenance.captureAdapter` or `trace.source`). Honest by construction: an unknown or
 * absent hint resolves to `other` rather than guessing a specific tool. Never returns a value the
 * caller did not actually produce.
 */
export function resolveToolName(hint: string | null | undefined): ToolName {
  if (!hint) return "other";
  const h = hint.trim().toLowerCase();
  if (h === "claude-code" || h === "claude_code") return "claude-code";
  if (h === "openai-agents" || h === "openai_agents") return "openai-agents";
  if (h.startsWith("codex")) return "codex"; // codex, codex_import, codex-exec
  if (h.startsWith("cursor")) return "cursor"; // cursor, cursor_import (adapter pending)
  return "other";
}
