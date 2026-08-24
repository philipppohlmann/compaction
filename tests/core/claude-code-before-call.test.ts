import { describe, expect, it } from "vitest";
import {
  parseUserPromptSubmitPayload,
  buildClaudeCodeBeforeCallEvent,
  CLAUDE_CODE_BEFORE_CALL_APPLY_BLOCKER
} from "../../src/core/claude-code-before-call.js";
import { detectAvoidableContext } from "../../src/core/before-call.js";
import { validateActivityEvent } from "../../src/core/activity-event.js";

/**
 * Claude Code before-call recommendation core. The UserPromptSubmit hook is a genuine
 * PRE-call event, but apply is a PROVEN BLOCKER on this surface (no hook can reduce the model's context;
 * hooks are non-interactive). These assert: fail-closed payload parsing, content-free recommendation-only
 * events, honest local-estimate labels, and that the apply blocker rides on every event.
 */

const BLOCK = "SHARED CONTEXT BLOCK long enough to clear the duplicate size floor here for sure.";
const SECRET = "SECRET_CC_PROMPT_marker_do_not_store";
const dupPrompt = `${BLOCK}\n\ndo the task with ${SECRET}, concisely.\n\n${BLOCK}`;

describe("parseUserPromptSubmitPayload - fail-closed", () => {
  it("parses the real UserPromptSubmit shape (prompt + cwd + session_id)", () => {
    const raw = JSON.stringify({
      session_id: "s1",
      transcript_path: "/x.jsonl",
      cwd: "/proj",
      hook_event_name: "UserPromptSubmit",
      prompt: "hello world"
    });
    const p = parseUserPromptSubmitPayload(raw);
    expect(p).toEqual({ prompt: "hello world", cwd: "/proj", sessionId: "s1" });
  });

  it("returns null for non-JSON, non-object, missing prompt, or a wrong hook_event_name", () => {
    expect(parseUserPromptSubmitPayload("not json")).toBeNull();
    expect(parseUserPromptSubmitPayload("42")).toBeNull();
    expect(parseUserPromptSubmitPayload(JSON.stringify({ cwd: "/p" }))).toBeNull(); // no prompt
    expect(parseUserPromptSubmitPayload(JSON.stringify({ hook_event_name: "Stop", prompt: "x" }))).toBeNull();
  });

  it("accepts a payload with prompt but no hook_event_name (field is optional/defensive)", () => {
    expect(parseUserPromptSubmitPayload(JSON.stringify({ prompt: "x" }))).toEqual({ prompt: "x" });
  });
});

describe("buildClaudeCodeBeforeCallEvent - content-free, recommendation-only, apply-blocked", () => {
  const result = detectAvoidableContext(dupPrompt);

  it("the fixture prompt has avoidable context (so there is something to recommend)", () => {
    expect(result.has_avoidable_context).toBe(true);
    expect(result.input_tokens_after_estimate).toBeLessThan(result.input_tokens_before);
  });

  it("builds a valid claude_code event: local-estimate input, output unavailable, recommendation-only", () => {
    const event = buildClaudeCodeBeforeCallEvent(result, { sessionId: "s1" });
    expect(validateActivityEvent(event).problems).toEqual([]);
    expect(event.surface).toBe("claude_code");
    expect(event.provider).toBe("anthropic");
    expect(event.token_source.input.source).toBe("local-estimate");
    expect(event.token_source.output.source).toBe("unavailable");
    expect(event.input_before).toBeGreaterThan(event.input_after!);
    // recommendation-only: nothing applied, nothing to approve, auto-apply OFF
    expect(event.approval_status).toBe("not-required");
    expect(event.auto_apply?.applied_automatically).toBe(false);
    expect(event.recovery?.original_retained).toBe(true); // original prompt ran unchanged
    expect(event.sync_status).toBe("local-only");
    expect(event.session_id).toBe("s1");
  });

  it("carries the APPLY BLOCKER + honest labels on the caveats (no overclaim)", () => {
    const raw = JSON.stringify(buildClaudeCodeBeforeCallEvent(result));
    expect(raw).toContain(CLAUDE_CODE_BEFORE_CALL_APPLY_BLOCKER);
    expect(raw).toContain("RECOMMENDATION-ONLY");
    expect(raw).toContain("UserPromptSubmit");
    expect(raw).toContain("NOT the post-session Stop hook"); // honest: not a Stop-hook fake
    expect(raw).toContain("NOT a saving");
    expect(raw).toContain("NOT provider-reported");
    expect(raw).not.toMatch(/"provider_reported_tokens":true/);
  });

  it("is CONTENT-FREE: neither the prompt nor the secret appears anywhere on the event", () => {
    const raw = JSON.stringify(buildClaudeCodeBeforeCallEvent(result, { sessionId: "s1" }));
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(BLOCK);
    expect(raw).not.toContain("do the task with");
  });

  it("is deterministic - same input state → same activity_event_id (store dedupes a re-submit)", () => {
    const a = buildClaudeCodeBeforeCallEvent(result, { sessionId: "s1" });
    const b = buildClaudeCodeBeforeCallEvent(result, { sessionId: "s1" });
    expect(a.activity_event_id).toBe(b.activity_event_id);
  });
});
